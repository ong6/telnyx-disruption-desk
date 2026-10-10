// The Disruption Desk conversation workflow, as data. build.mjs sends it to the Assistants API.
//
// Routing rule of thumb: facts our systems already know (disruption mode, special assistance,
// human queue, call length) route with variable comparisons, which Telnyx evaluates before the
// model's turn, so they are deterministic. What the caller wants routes with LLM conditions.

const v = (name) => ({ type: "variable", name });
const s = (value) => ({ type: "string_literal", value });
const n = (value) => ({ type: "number_literal", value });
const cmp = (op, left, right) => ({ type: "comparison", op, left, right });
const and = (...operands) => ({ type: "bool_op", op: "and", operands });
const expr = (expression) => ({ type: "expression", expression });
const llm = (prompt) => ({ type: "llm", prompt });
const DEFAULT = { type: "default" };

const prompt = (id, name, instructions) => ({ id, name, type: "prompt", instructions_mode: "append", instructions });
const speak = (id, name, message) => ({ id, name, type: "speak", message });
const tool = (id, name, shared_tool_id, message) => ({ id, name, type: "tool", shared_tool_id, message });

export function buildFlow({ transferToolId, hangupToolId, mandarinAssistantId }) {
  const nodes = [
    speak("n_open", "Disclosure", "Thanks for calling Nimbus Air. This call may be recorded for quality and training, and you're speaking with our automated assistant. You can ask for a person at any time."),
    prompt("n_route", "Route opening", "Routing step: say nothing here."),
    speak("n_incident", "Incident notice", "{{incident_notice}}"),
    prompt("n_triage", "Greet & identify need", [
      "Open the conversation and find out what the caller needs.",
      "Keep this first turn to two short sentences and one question. Don't repeat the incident notice; the caller just heard it.",
      "If caller_known is true: greet {{first_name}} by name. If callback_reason is seat_available, say you're calling back because a seat opened up and it is held for them, and offer to confirm it. Otherwise, if their flight is cancelled or delayed, say so in one sentence and ask whether they'd like a new flight. If they already have a seat on hold, say so and offer to confirm it. If they were already rebooked, give the confirmation code ({{rebooked_confirmation}}).",
      "If caller_known is false: ask how you can help. You'll verify their booking later if it's needed.",
      "Needs: change or rebook a flight, a refund, flight status or a policy question, or a person.",
      "If the caller speaks Chinese or asks for Mandarin, never say you only speak English: reply in Chinese that you're connecting them to our Chinese-speaking desk (我现在为您转接中文服务).",
    ].join("\n")),
    prompt("n_rebook", "Rebook", [
      "Move the caller to another flight.",
      "1. If caller_known is false and you haven't verified them yet, ask for the 6-character booking code (read it back letter by letter) and last name, then call verify_booking. If it returns attempts_left 0, tell the caller you're connecting them with a colleague.",
      "2. Call find_alternatives. Offer at most two options, earliest first, with day and departure time. Mention seats are limited.",
      "3. When they choose, call hold_seats with that flight_id. If the hold fails because the flight just filled, say so and offer the next option.",
      "4. Once held, read back the flight, date, time and number of passengers, and ask for a clear yes.",
    ].join("\n")),
    prompt("n_confirm", "Confirm", [
      "Call confirm_rebooking now.",
      "Then give the confirmation code slowly using the spelled version the tool returned, and offer to repeat it. Mention the new flight and departure time once more.",
      "If the hold expired, apologise and say you'll find the next option.",
    ].join("\n")),
    speak("n_refund_rights", "Refund rights (verbatim)", "Because Nimbus Air cancelled your flight, you're entitled to a full refund of your ticket, including taxes and fees, to your original form of payment within seven business days. You can also move to another Nimbus Air flight within seven days at no cost."),
    prompt("n_refund", "Refund", [
      "If caller_known is false and you haven't verified them yet, verify with verify_booking first.",
      "Check they want the refund rather than a free change. Then call request_refund.",
      "If it succeeds, give the refund reference using the spelled version and the timeline. If they aren't eligible, explain why in one sentence and offer to change the flight instead.",
    ].join("\n")),
    prompt("n_waitlist", "Waitlist & care", [
      "No suitable flight has seats. Offer the waitlist on the earliest flight that works for them: if a seat frees up we hold it and call them straight back, so they don't need to stay on the line.",
      "Call join_waitlist with that flight_id. If a voucher is issued, give the code using the spelled version and say what it covers.",
    ].join("\n")),
    prompt("n_faq", "Status & policy", [
      "Answer questions about the caller's flight with get_trip_status (verify unknown callers first with verify_booking), and policy questions only from get_policy.",
      "Keep answers to two or three sentences.",
    ].join("\n")),
    prompt("n_handoff_gate", "Human handoff gate", "Routing step: say nothing here."),
    tool("n_human", "Transfer to agent", transferToolId, "I'm connecting you with a member of our team now, and I'll pass on what we've discussed."),
    tool("n_specialist", "Special assistance transfer", transferToolId, "I can see your booking includes special assistance, so I'm connecting you with a specialist who can arrange everything for you."),
    prompt("n_callback", "Callback offer", [
      "Our team can't take a transfer right now. Apologise briefly and offer a callback from a person within two hours.",
      "If they accept, call request_callback with a one-line reason for the agent. Then confirm it's booked.",
    ].join("\n")),
    prompt("n_wrap", "Wrap up", "Ask if there's anything else. If there isn't, thank them, wish them a safe trip, and end the call with the hangup tool."),
  ];

  // Tools per prompt node (MCP tools are listed by name; build.mjs maps them to the node).
  const scope = {
    n_route: [],
    n_triage: [],
    n_rebook: ["verify_booking", "find_alternatives", "hold_seats"],
    n_confirm: ["confirm_rebooking"],
    n_refund: ["verify_booking", "request_refund"],
    n_waitlist: ["find_alternatives", "join_waitlist"],
    n_faq: ["verify_booking", "get_trip_status", "get_policy"],
    n_handoff_gate: [],
    n_callback: ["request_callback"],
    n_wrap: [],
  };

  let i = 0;
  const edges = [];
  const edge = (from, to, condition) => edges.push({ id: `e${++i}_${from}_${to}`.slice(0, 60), start_node_id: from, target: to.startsWith("assistant:") ? { type: "assistant", assistant_id: to.slice(10), voice_mode: "distinct" } : { type: "node", node_id: to }, condition });

  // Opening: the incident notice plays only when disruption mode is on (flag in KV, via the
  // webhook). A speak node always follows its one default edge, so a silent prompt node routes.
  edge("n_open", "n_route", DEFAULT);
  edge("n_route", "n_incident", expr(cmp("==", v("disruption_mode"), s("on"))));
  edge("n_route", "n_triage", expr(cmp("!=", v("disruption_mode"), s("on"))));
  edge("n_incident", "n_triage", DEFAULT);

  // Hard rules first: these run before the model's turn.
  edge("n_triage", "n_specialist", expr(and(cmp("==", v("special_assistance"), s("true")), cmp("==", v("human_queue"), s("open")))));
  // Caller intent.
  edge("n_triage", "n_rebook", llm("The caller wants to change, move or rebook their flight, or accepts your offer to rebook, or wants to confirm a held seat."));
  edge("n_triage", "n_refund_rights", llm("The caller wants a refund or no longer wants to travel."));
  edge("n_triage", "n_faq", llm("The caller asks about their flight status, baggage, vouchers, special assistance or another policy question."));
  edge("n_triage", `assistant:${mandarinAssistantId}`, llm("The caller writes or speaks in Chinese, asks for Chinese or Mandarin, or you said you're connecting them to the Chinese-speaking desk."));

  edge("n_rebook", "n_confirm", llm("Seats are held with hold_seats and the caller clearly said yes to confirm."));
  edge("n_rebook", "n_waitlist", llm("find_alternatives returned no options, or none of the options work for the caller."));
  edge("n_rebook", "n_refund_rights", llm("The caller would rather have a refund than a new flight."));
  edge("n_confirm", "n_wrap", llm("The rebooking is confirmed and the caller has the confirmation code."));
  edge("n_confirm", "n_rebook", llm("The hold expired, or the caller wants a different flight after all."));
  edge("n_refund_rights", "n_refund", DEFAULT);
  edge("n_refund", "n_wrap", llm("The refund is done, or the caller was told they aren't eligible and has no further request."));
  edge("n_refund", "n_rebook", llm("The caller decides to change their flight instead of a refund."));
  edge("n_waitlist", "n_wrap", llm("The caller is on the waitlist, or declined it."));
  edge("n_faq", "n_rebook", llm("The caller wants to change or rebook their flight."));
  edge("n_faq", "n_refund_rights", llm("The caller wants a refund."));
  edge("n_faq", "n_wrap", llm("The caller's question is answered and they need nothing else."));
  edge("n_callback", "n_wrap", llm("The callback is booked, or the caller declined it."));

  // Three failed verifications: verify_booking stores attempts_left as a variable, so this is a
  // deterministic variable comparison, not something the model has to notice.
  const lockedOut = { type: "bool_op", op: "or", operands: [cmp("==", v("verify_attempts_left"), n(0)), cmp("==", v("verify_attempts_left"), s("0"))] };
  for (const node of ["n_rebook", "n_refund", "n_faq"]) edges.unshift({ id: `e0_${node}_locked`, start_node_id: node, target: { type: "node", node_id: "n_handoff_gate" }, condition: expr(lockedOut) });

  // Every conversational node can reach a person: on request, after 3 failed verifications, or
  // after 5 minutes. The confirm step is exempt from the timer so a booking is never cut off.
  for (const node of ["n_triage", "n_rebook", "n_confirm", "n_refund", "n_waitlist", "n_faq", "n_wrap"]) {
    if (node !== "n_confirm") edge(node, "n_handoff_gate", expr(cmp(">=", v("telnyx_conversation_duration_secs"), n(300))));
    edge(node, "n_handoff_gate", llm("The caller asks for a person, an agent or a supervisor, or is very upset, or you told the caller you're connecting them with a colleague."));
  }
  // The gate decides deterministically: transfer if the desk can take it, otherwise a callback.
  edge("n_handoff_gate", "n_callback", expr(cmp("==", v("human_queue"), s("full"))));
  edge("n_handoff_gate", "n_human", expr(cmp("!=", v("human_queue"), s("full"))));
  edge("n_human", "n_callback", DEFAULT); // only used if the transfer fails
  edge("n_specialist", "n_callback", DEFAULT);

  return { flow: { start_node_id: "n_open", nodes, edges }, scope, hangupToolId };
}

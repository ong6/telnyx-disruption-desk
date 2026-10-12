// The Disruption Desk conversation workflow, as data. build.mjs sends it to the Assistants API.
//
// Routing rule of thumb: facts our systems already know (special assistance, human queue, call
// length) route with variable comparisons, which Telnyx evaluates before the model's turn, so they
// are deterministic. What the caller wants routes with LLM conditions.
//
// On calls an LLM edge is not judged separately: Telnyx offers it to the model as a tool named
// `transition__<edge id>` and the edge fires only when the model calls it (chat judges edges in a
// separate call, which is why chat never showed the two bugs below). So:
// - every edge id must be a valid tool-name suffix. An id with a colon and over 64 characters
//   (`e6_n_triage_assistant:assistant-…`) made every model turn on a call fail (DEBUGLOG #21);
// - node instructions say when to call each transition, or the model does the next step's work
//   itself and the flow never moves.

const v = (name) => ({ type: "variable", name });
const s = (value) => ({ type: "string_literal", value });
const n = (value) => ({ type: "number_literal", value });
const cmp = (op, left, right) => ({ type: "comparison", op, left, right });
const and = (...operands) => ({ type: "bool_op", op: "and", operands });
const or = (...operands) => ({ type: "bool_op", op: "or", operands });
const expr = (expression) => ({ type: "expression", expression });
const llm = (prompt) => ({ type: "llm", prompt });
const DEFAULT = { type: "default" };

const prompt = (id, name, instructions) => ({ id, name, type: "prompt", instructions_mode: "append", instructions: instructions.join("\n") });
const speak = (id, name, message) => ({ id, name, type: "speak", message });
const tool = (id, name, shared_tool_id, message) => ({ id, name, type: "tool", shared_tool_id, message });

/** Telnyx prefixes "transition__" (12 characters) and tool names allow [A-Za-z0-9_-]{1,64}. */
export const EDGE_ID = /^[a-z0-9_]{1,52}$/;

const VERIFY = "If caller_known is false and the caller isn't verified yet, ask for the 6-character booking code and their last name, then call verify_booking. If it fails, read back the code and the name you used, ask which one is wrong, and ask them to spell the name. After the third failed try, or when attempts_left is 0, tell them you're connecting them with a colleague and call the transition to a person.";

export function buildFlow({ transferToolId, hangupToolId, queueToolId, mandarinAssistantId }) {
  const nodes = [
    // Verbatim at pickup: the disclosure, today's incident, and the choices. opening_offer comes
    // from the webhook, worded for what we know ("Hi Jun. Your flight to Hong Kong is cancelled.
    // I can rebook you for free, cancel it for a full refund, or connect you with a person."), and
    // defaults to the anonymous version. A speak node waits for the caller afterwards, so the
    // choices go here, where every caller hears them. (DEBUGLOG #20 blamed this speak node for
    // calls that hung; the real cause was the edge id in #21, and it is verified on calls.)
    speak("n_open", "Disclosure, incident and choices", "Thanks for calling Nimbus Air. This call may be recorded for quality and training, and you're speaking with our automated assistant. {{incident_notice}} {{opening_offer}}"),
    prompt("n_triage", "Identify need", [
      "The caller has just heard the opening, which offered to rebook or cancel their flight or connect them with a person. Don't repeat it or the incident notice.",
      "Your only tools here are the transitions. As soon as the caller says what they want, call the matching one in that same turn, with at most a few words like \"Sure.\" The next step checks their booking and does the work.",
      "If it isn't clear what they want, ask one short question: would they like to rebook, cancel, or speak to a person?",
      "If the caller speaks Chinese or asks for Mandarin, say \"Sure, I'll connect you to our Mandarin desk. 请稍等。\" and call the Mandarin transition in the same turn.",
    ]),
    prompt("n_rebook", "Rebook: date, then time", [
      "Move the caller to another flight: settle the date first, then the time. If a seat is already on hold for them (has_active_hold, or the seat offered on a callback) and they want it, go straight to step 5.",
      `1. Verify. ${VERIFY}`,
      "2. Date. Call find_dates. Offer the first two or three dates using their say text, say the fee_say line once, and ask which day suits them. If they name a day that isn't listed, say it has no seats left and offer the nearest listed days.",
      "3. Time. Once the date is clear, call find_flights with it. Offer up to three departure times, earliest first or in the part of the day they asked for, and ask which time they'd like. If none suit, offer the rest. If the day has no seats, offer another date, or the waitlist on one of its full flights.",
      "4. Hold. When they pick a time, call hold_seats with that flight_id. If it just filled up, say so and offer the next time.",
      "5. Confirm. Read back the flight, date and departure time, the passengers by name ({{first_name}} and their party) and the change fee, then ask for a clear yes. When they say yes, call the transition to confirm. If they ask something else first, answer it and ask again.",
      "Only offer dates and times a tool returned.",
    ]),
    prompt("n_confirm", "Confirm", [
      "Call confirm_rebooking now, then say its say line: the new flight, the confirmation code read slowly letter by letter, and the change fee. Offer to repeat the code.",
      "If the hold expired, apologise and call the transition back to rebooking.",
      "Once the caller has the code and needs nothing more on this booking, call the wrap-up transition.",
    ]),
    prompt("n_cancel", "Cancel", [
      "The caller wants to cancel their flight.",
      `1. Verify. ${VERIFY}`,
      "2. If Nimbus Air cancelled or delayed their flight (flight_status, or original_flight_status from a tool), call the refund transition straight away: they're entitled to a full refund.",
      "3. Otherwise the flight is operating. Say, in two short sentences, that the fare isn't refundable, but if they cancel the full ticket value is kept as travel credit for 12 months; or you can move them to another date and time for a 100 Singapore dollar change fee. Ask whether to cancel.",
      "4. On a clear yes, call cancel_booking and give the travel credit reference using the spelled version. If they'd rather change the flight, call the rebook transition. Then call the wrap-up transition.",
    ]),
    speak("n_refund_rights", "Refund rights (verbatim)", "Because Nimbus Air cancelled your flight, you're entitled to a full refund of your ticket, including taxes and fees, to your original form of payment within seven business days. You can also move to another Nimbus Air flight within seven days at no cost. Would you like me to process the full refund now?"),
    prompt("n_refund", "Refund", [
      "The refund-rights statement has just been read to the caller; don't repeat it.",
      `If they aren't verified yet: ${VERIFY}`,
      "If the caller has already asked for the refund in their own words, that is the yes: call request_refund right away. Only ask one short question if they are undecided between a refund and a free change; if they choose the change, call the rebook transition.",
      "When it succeeds, give the refund reference using the spelled version and the timeline, in that same reply. If they aren't eligible, explain why in one sentence and offer to change the flight instead.",
    ]),
    prompt("n_waitlist", "Waitlist & care", [
      "No date and time with seats works for the caller. Offer the waitlist on the flight they wanted (a flight_id from full_flights in find_flights): if seats free up we hold them and call them straight back, so they don't need to stay on the line.",
      "Call join_waitlist with that flight_id. If a voucher is issued, give the code using the spelled version and say what it covers.",
    ]),
    prompt("n_faq", "Status & policy", [
      "Answer questions about the caller's flight with get_trip_status (verify unknown callers first with verify_booking), and policy questions only from get_policy.",
      "Keep answers to two or three sentences. If they then want to rebook or cancel, call that transition.",
    ]),
    // A tool node runs immediately, with no model turn: it asks desk-ops whether a person is free
    // and routes on the HTTP status (200 = transfer, anything else = callback).
    tool("n_handoff_gate", "Human handoff gate", queueToolId, "One moment, let me get a colleague for you."),
    tool("n_human", "Transfer to agent", transferToolId, "I'm connecting you with a member of our team now, and I'll pass on what we've discussed."),
    tool("n_specialist", "Special assistance transfer", transferToolId, "I can see your booking includes special assistance, so I'm connecting you with a specialist who can arrange everything for you."),
    prompt("n_callback", "Callback offer", [
      "Our team can't take a transfer right now. Apologise briefly and offer a callback from a person within two hours.",
      "If they accept, call request_callback with a one-line reason for the agent (set transfer_failed to true if a transfer was just attempted). Then confirm it's booked and call the wrap-up transition.",
    ]),
    prompt("n_wrap", "Wrap up", ["Ask if there's anything else. If there isn't, thank them, wish them a safe trip, and end the call with the hangup tool."]),
  ];

  // Tools per prompt node (MCP tools are listed by name; build.mjs maps them to the node).
  const scope = {
    n_triage: [],
    n_rebook: ["verify_booking", "find_dates", "find_flights", "hold_seats"],
    n_confirm: ["confirm_rebooking"],
    n_cancel: ["verify_booking", "get_trip_status", "cancel_booking"],
    n_refund: ["verify_booking", "request_refund"],
    n_waitlist: ["find_flights", "join_waitlist"],
    n_faq: ["verify_booking", "get_trip_status", "get_policy"],
    n_callback: ["request_callback"],
    n_wrap: [],
  };

  const edges = [];
  const short = (id) => id.replace(/^n_/, "");
  const edge = (from, to, condition, suffix = "") => {
    const target = to.startsWith("assistant:") ? { type: "assistant", assistant_id: to.slice(10), voice_mode: "distinct" } : { type: "node", node_id: to };
    const id = `${short(from)}_${to.startsWith("assistant:") ? "mandarin" : short(to)}${suffix}`;
    edges.push({ id, start_node_id: from, target, condition });
  };

  edge("n_open", "n_triage", DEFAULT);

  // Hard rules first: these run before the model's turn.
  edge("n_triage", "n_specialist", expr(and(cmp("==", v("special_assistance"), s("true")), cmp("==", v("human_queue"), s("open")))));
  // Caller intent.
  edge("n_triage", "n_rebook", llm("The caller wants to rebook, change or move their flight, or wants to confirm a seat that is held for them."));
  edge("n_triage", "n_cancel", llm("The caller wants to cancel their flight, get a refund, or no longer wants to travel."));
  edge("n_triage", "n_faq", llm("The caller asks about their flight status, baggage, vouchers, special assistance or another policy question."));
  edge("n_triage", `assistant:${mandarinAssistantId}`, llm("The caller speaks Chinese, or asks for Chinese or Mandarin."));

  edge("n_rebook", "n_confirm", llm("Seats are held with hold_seats and the caller clearly said yes to confirm them."));
  edge("n_rebook", "n_waitlist", llm("No date or time with seats works for the caller and they want to wait for a seat."));
  edge("n_rebook", "n_cancel", llm("The caller would rather cancel or get a refund than move to another flight."));
  edge("n_confirm", "n_wrap", llm("The rebooking is confirmed and the caller has the confirmation code."));
  edge("n_confirm", "n_rebook", llm("The hold expired, or the caller wants a different flight after all."));
  edge("n_cancel", "n_refund_rights", llm("Nimbus Air cancelled or delayed the caller's flight, so they are entitled to a full refund."));
  edge("n_cancel", "n_rebook", llm("The caller decides to change their flight instead of cancelling."));
  edge("n_cancel", "n_wrap", llm("The booking is cancelled and the caller has the travel credit reference, or they decided to keep their booking."));
  edge("n_refund_rights", "n_refund", DEFAULT);
  edge("n_refund", "n_wrap", llm("The refund is done, or the caller was told they aren't eligible and has no further request."));
  edge("n_refund", "n_rebook", llm("The caller decides to change their flight instead of a refund."));
  edge("n_waitlist", "n_wrap", llm("The caller is on the waitlist, or declined it."));
  edge("n_faq", "n_rebook", llm("The caller wants to rebook or change their flight."));
  edge("n_faq", "n_cancel", llm("The caller wants to cancel their flight or get a refund."));
  edge("n_faq", "n_wrap", llm("The caller's question is answered and they need nothing else."));
  edge("n_callback", "n_wrap", llm("The callback is booked, or the caller declined it."));

  // Every conversational node can reach a person: on request, or after 3 failed verifications.
  // Where a caller can get stuck, also after 5 minutes; confirm and wrap-up are exempt so a
  // booking or a goodbye is never turned into a transfer.
  for (const node of ["n_triage", "n_rebook", "n_confirm", "n_cancel", "n_refund", "n_waitlist", "n_faq", "n_wrap"]) {
    if (node !== "n_confirm" && node !== "n_wrap") edge(node, "n_handoff_gate", expr(cmp(">=", v("telnyx_conversation_duration_secs"), n(300))), "_timer");
    edge(node, "n_handoff_gate", llm("The caller asks for a person, an agent or a supervisor, or is very upset, or you told the caller you're connecting them with a colleague."), "_person");
  }
  // The gate decides deterministically on the queue check's status code: "200" on calls, 200 in chat.
  edge("n_handoff_gate", "n_human", expr(or(cmp("==", v("telnyx_last_tool_status_code"), s("200")), cmp("==", v("telnyx_last_tool_status_code"), n(200)))));
  edge("n_handoff_gate", "n_callback", DEFAULT);
  edge("n_human", "n_callback", DEFAULT); // only used if the transfer fails
  edge("n_specialist", "n_callback", DEFAULT);

  return { flow: { start_node_id: "n_open", nodes, edges }, scope, hangupToolId };
}

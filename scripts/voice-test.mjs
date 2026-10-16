#!/usr/bin/env node
// Voice-path scenario tests, no phone needed. A "test caller" assistant plays a passenger and
// places a real outbound AI call from the desk's TeXML app to the desk's SIP address, so the call
// runs the same voice pipeline a phone call does (speech-to-text, transitions as tool calls,
// text-to-speech). Both sides' transcripts come back from the Conversations API and are checked.
// Chat tests can't see voice-only failures: DEBUGLOG #21 passed every chat test while every call
// hung. Results go to docs/evidence/voice-<time>.md.
//
// No scenario ever reaches a transfer: transfers dial HUMAN_DESK_NUMBER, a real phone. The person
// scenario runs with the human queue full (callback path), and person_demo is safe because handoff
// end_call hangs the desk up instead of dialling. The script hangs every call up through Call
// Control once the scenario is done. (The caller can't hang up itself: with a shared hangup tool
// attached, the caller assistant never took a turn on a call.)
// Usage: source scripts/env.sh && node scripts/voice-test.mjs [--no-reset] [scenario ...]
import { writeFileSync } from "node:fs";

const API = "https://api.telnyx.com/v2";
const H = { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "content-type": "application/json" };
const OPS = process.env.OPS_URL ?? "https://desk-ops-68bad318-0.telnyxcompute.com";
const DESK = "assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b";
const MANDARIN_DESK = "assistant-7b3cda63-812a-47b3-8509-1dc9db898dcd";
const CALLER_NAME = "Nimbus test caller";
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 300)}`);
  const j = t ? JSON.parse(t) : {};
  return j.data ?? j;
};
const ops = (path, body) =>
  fetch(`${OPS}${path}`, { method: "POST", headers: { authorization: `Bearer ${process.env.DESK_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAY = "You are role-playing a passenger phoning the Nimbus Air airline. Wait for the airline to speak first. Answer the agent briefly and naturally, one short sentence per turn, and never act as the airline. If the agent can't find your booking, spell your last name letter by letter.";
const END = "When your request is done and the agent asks if there's anything else, say no thanks and goodbye.";

const said = (msgs, re) => msgs.some((m) => m.role === "assistant" && re.test(m.text));
const order = (tools, a, b) => tools.includes(a) && tools.includes(b) && tools.indexOf(a) < tools.indexOf(b);

const SCENARIOS = {
  "rebook-typhoon": {
    persona: `${PLAY} You are Jun Ong, booking code K7Q2ZX, last name Ong. Your flight to Hong Kong today was cancelled. You want to rebook. When asked which day, choose the second day offered. When offered times, pick the earliest one. Say yes clearly when asked to confirm, and repeat back the confirmation code. ${END}`,
    checks: {
      "date asked before time": ({ tools }) => order(tools, "find_dates", "find_flights"),
      "held, then confirmed": ({ tools }) => order(tools, "hold_seats", "confirm_rebooking"),
      "change is free (typhoon)": ({ desk }) => said(desk, /no change fee|waiver|no charge|free/i) && !said(desk, /100 Singapore dollar/i),
      "offers rebook, cancel or a person": ({ desk }) => said(desk, /cancel/i) && said(desk, /person|colleague|someone/i),
    },
  },
  "rebook-fee": {
    persona: `${PLAY} You are Daniel Hughes, booking code H8N6CU, last name Hughes. You want to move your flight to Tokyo to another day. When asked which day, choose the first day offered after today. When offered times, ask for the afternoon one if there is one, otherwise the first. Accept the change fee. Say yes clearly when asked to confirm. ${END}`,
    checks: {
      "date asked before time": ({ tools }) => order(tools, "find_dates", "find_flights"),
      "held, then confirmed": ({ tools }) => order(tools, "hold_seats", "confirm_rebooking"),
      "quotes the 100 dollar fee": ({ desk }) => said(desk, /100/),
    },
  },
  "cancel-refund": {
    persona: `${PLAY} You are Priya Raman, booking code R2D5VK, last name Raman. Your flight to Hong Kong today was cancelled and you no longer want to travel: you want to cancel and get your money back. Refuse any offer to rebook. Say yes when asked whether to process the refund, and repeat the refund reference. ${END}`,
    checks: {
      "refund rights read verbatim": ({ desk }) => said(desk, /entitled to a full refund of your ticket, including taxes and fees/i),
      "refund processed": ({ tools }) => tools.includes("request_refund"),
    },
  },
  "cancel-credit": {
    persona: `${PLAY} You are Daniel Hughes, booking code H8N6CU, last name Hughes. Your trip to Tokyo is off and you want to cancel your flight. Accept the refund and say yes clearly when asked to cancel. Repeat the refund reference. ${END}`,
    checks: {
      "states the 100 dollar refund": ({ desk }) => said(desk, /refund 100 Singapore dollars|100 Singapore dollars/i),
      "booking cancelled": ({ tools }) => tools.includes("cancel_booking"),
      "no refund-rights statement": ({ desk }) => !said(desk, /entitled to a full refund/i),
    },
  },
  person: {
    // The queue is full for this one, so the gate offers a callback and nothing dials out.
    flags: { human_queue: "full" },
    persona: `${PLAY} You are frustrated. In your first reply say: I want to speak to a real person. If you're offered a callback, accept it. ${END}`,
    checks: {
      "callback offered and booked": ({ tools, desk }) => tools.includes("request_callback") && said(desk, /call(ing)? you back|callback/i),
    },
  },
  person_demo: {
    // With handoff end_call, a request for a person passes the queue check and the desk says the
    // demo handoff line and hangs up, so nothing dials out even with the queue open.
    flags: { human_queue: "open", handoff: "end_call" },
    persona: `${PLAY} You are frustrated. In your first reply say: I want to speak to a real person. ${END}`,
    checks: {
      "demo handoff line, no transfer": ({ desk, tools }) => said(desk, /demo line/i) && !tools.includes("request_callback"),
    },
  },
  mandarin: {
    // Hung up as soon as the Mandarin desk speaks: left talking, it once transferred to a person.
    doneWhen: ({ desk }) => desk.some((m) => m.assistant === MANDARIN_DESK && /[\u4e00-\u9fff]/.test(m.text)),
    persona: `${PLAY} In your first reply say in English: Can I speak to someone in Mandarin, please? If you then hear Chinese, say thank you.`,
    checks: {
      "handed to the Mandarin desk": ({ desk }) => desk.some((m) => m.assistant === MANDARIN_DESK && /[一-鿿]/.test(m.text)),
    },
  },
};

async function callerAssistant(persona) {
  const body = {
    name: CALLER_NAME, model: "zai-org/GLM-5.3-Flash", instructions: persona, greeting: "",
    voice_settings: { voice: "Telnyx.KokoroTTS.am_adam" }, tool_ids: [],
    // A backstop: the script hangs up first.
    enabled_features: ["telephony"], telephony_settings: { time_limit_secs: 300 },
  };
  const existing = (await api("GET", "/ai/assistants")).find?.((a) => a.name === CALLER_NAME);
  return existing ? (await api("POST", `/ai/assistants/${existing.id}`, body), existing.id) : (await api("POST", "/ai/assistants", body)).id;
}

const messages = async (id) =>
  (await api("GET", `/ai/conversations/${id}/messages?page%5Bsize%5D=100`)).slice().reverse().map((m) => ({
    ts: Date.parse(m.sent_at ?? m.created_at ?? ""), at: (m.sent_at ?? m.created_at ?? "").slice(11, 19), role: m.role, text: typeof m.text === "string" ? m.text : JSON.stringify(m.text ?? ""),
    node: m.metadata?.flow_node_id, assistant: m.metadata?.assistant_id, tools: (m.tool_calls ?? []).map((t) => t.function?.name),
  }));

/** One call. Messages reach the API about 30 s after they are spoken, and the opening alone runs
 *  ~18 s, so "quiet" means 90 s with no new message on either side; the desk hanging up, or the
 *  scenario's own check, ends it sooner. After hanging up, wait for the last messages to land.
 *  Returns null if the call never connected (the desk heard nothing within 90 s), which happened
 *  on calls placed right after a persona update. */
async function call(s, callerId, texmlAppId) {
  const since = new Date(Date.now() - 2000).toISOString();
  await api("POST", `/texml/ai_calls/${texmlAppId}`, { From: process.env.DESK_NUMBER, To: `sip:anonymous@${DESK}.sip.telnyx.eu`, AIAssistantId: callerId });
  let callerConv, deskConv, desk = [], caller = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    await sleep(5_000);
    const convs = (await api("GET", "/ai/conversations?order=created_at.desc&limit=10")).filter((c) => c.created_at >= since);
    callerConv = convs.find((c) => c.metadata?.assistant_id === callerId);
    deskConv = convs.find((c) => c !== callerConv && String(c.metadata?.telnyx_agent_target ?? "").includes(DESK));
    desk = deskConv ? await messages(deskConv.id) : [];
    caller = callerConv ? await messages(callerConv.id) : [];
    const connected = desk.some((m) => m.role === "user");
    if (!connected && Date.now() - t0 > 90_000) break;
    const last = Math.max(t0, ...[...desk, ...caller].map((m) => m.ts || 0));
    if (s.doneWhen?.({ desk }) || desk.some((m) => m.tools.includes("hangup")) || (connected && Date.now() - last > 90_000)) break;
  }
  const control = callerConv?.metadata?.call_control_id;
  if (control) await fetch(`${API}/calls/${encodeURIComponent(control)}/actions/hangup`, { method: "POST", headers: H, body: "{}" }).catch(() => {});
  await sleep(35_000);
  desk = deskConv ? await messages(deskConv.id) : [];
  caller = callerConv ? await messages(callerConv.id) : [];
  return desk.some((m) => m.role === "user") ? { deskConv, desk, caller } : null;
}

async function run(name, s, callerId, texmlAppId) {
  // If the flags can't be written, the queue may still be open and the call would transfer to a
  // real phone: skip the scenario instead.
  if (s.flags && (await ops("/api/flags", s.flags)) !== 200)
    return { name, desk: [], tools: [], attempts: 0, results: [{ check: "skipped: could not set the flags (is KV up?)", ok: false }] };
  await callerAssistant(s.persona);
  await sleep(5_000); // let the new caller version settle before dialling
  let attempts = 1;
  let r = await call(s, callerId, texmlAppId);
  if (!r) (attempts = 2), (r = await call(s, callerId, texmlAppId));
  if (s.flags) await ops("/api/flags", { human_queue: "open" });
  const { deskConv, desk, caller } = r ?? { desk: [], caller: [] };
  const tools = desk.flatMap((m) => m.tools);
  const results = Object.entries(s.checks).map(([check, fn]) => ({ check, ok: !!fn({ desk, caller, tools }) }));
  const replied = desk.some((m) => m.role === "assistant" && m.node !== "n_open" && m.text.trim());
  results.unshift({ check: "desk replies on the call", ok: replied });
  return { name, deskConv: deskConv?.id, desk, tools, results, attempts };
}

const argv = process.argv.slice(2);
const names = argv.filter((a) => !a.startsWith("--"));
const picked = names.length ? names : Object.keys(SCENARIOS);
const unknown = picked.filter((n) => !SCENARIOS[n]);
if (unknown.length) throw new Error(`unknown scenario ${unknown.join(", ")}; known: ${Object.keys(SCENARIOS).join(", ")}`);
if (!argv.includes("--no-reset")) console.log("scenario reset", await ops("/api/scenario", { id: "typhoon" }));
const texmlAppId = (await api("GET", `/ai/assistants/${DESK}`)).telephony_settings.default_texml_app_id;
const callerId = await callerAssistant("");
const report = [];
for (const name of picked) {
  const r = await run(name, SCENARIOS[name], callerId, texmlAppId);
  report.push(r);
  console.log(`\n${name}: ${r.results.every((x) => x.ok) ? "PASS" : "FAIL"}  (conversation ${r.deskConv ?? "none"}${r.attempts > 1 ? ", second call: the first never connected" : ""})`);
  for (const x of r.results) console.log(`  ${x.ok ? "✓" : "✗"} ${x.check}`);
  console.log(`  tools: ${r.tools.join(" → ") || "none"}`);
}

const lines = [`# Voice scenario run ${new Date().toISOString()}`, "", "AI-to-AI calls over SIP (`scripts/voice-test.mjs`). Desk side shown; `[node]` is the workflow node.", "",
  "| Scenario | Result | Conversation |", "|---|---|---|", ...report.map((r) => `| ${r.name} | ${r.results.every((x) => x.ok) ? "pass" : "fail: " + r.results.filter((x) => !x.ok).map((x) => x.check).join("; ")}${r.attempts > 1 ? " (second call)" : ""} | ${r.deskConv ?? ""} |`), ""];
for (const r of report) {
  lines.push(`## ${r.name}`, "", ...r.results.map((x) => `- ${x.ok ? "✓" : "✗"} ${x.check}`), "", "```");
  for (const m of r.desk) lines.push(`${m.at} ${m.role}${m.node ? ` [${m.node}]` : ""}${m.assistant === MANDARIN_DESK ? " [mandarin desk]" : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}${m.tools.length ? ` → ${m.tools.join(", ")}` : ""}`);
  lines.push("```", "");
}
const file = `docs/evidence/voice-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
writeFileSync(file, lines.join("\n"));
console.log("\nsaved", file);
if (!report.every((r) => r.results.every((x) => x.ok))) process.exitCode = 1;

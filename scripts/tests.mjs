#!/usr/bin/env node
// Scenario tests on Telnyx's built-in assistant testing: a simulated caller with instructions,
// graded against a rubric. Creates or updates each test by name in one suite, runs the suite,
// waits for results, and writes them to docs/evidence/.
// Usage: source scripts/env.sh && node scripts/tests.mjs [create|run|all]
import { writeFileSync } from "node:fs";

const API = "https://api.telnyx.com/v2";
const H = { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "content-type": "application/json" };
const ASSISTANT = "assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b";
const SUITE = "disruption-desk";
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 500)}`);
  const j = t ? JSON.parse(t) : {};
  return j.data ?? j;
};

const NO_INVENTION = { name: "No invented facts", criteria: "Every flight, time, seat count, code and policy the assistant states came from a tool result. It never makes one up." };
const PHONE_MANNER = { name: "Phone manner", criteria: "Short turns, one question at a time, never lists more than two options at once." };

const TESTS = [
  {
    name: "Cancelled flight: verify, rebook, confirm",
    instructions: "You are Priya Raman. Your Nimbus Air flight from Singapore to Hong Kong today was cancelled because of the typhoon. You are travelling with one other person. Your booking code is R2D5VK and your last name is Raman. Ask to move to the earliest flight that works, accept the first option offered, and confirm it when asked. Write down the confirmation code.",
    rubric: [
      { name: "Verifies first", criteria: "Asks for the booking code and last name before changing anything." },
      { name: "Holds then confirms", criteria: "Holds seats on the chosen flight, reads back the flight, date, time and passengers, and asks for a clear yes before confirming." },
      { name: "Code read back", criteria: "Gives a confirmation code and reads it letter by letter." },
      NO_INVENTION, PHONE_MANNER,
    ],
  },
  {
    name: "Family of four: never split",
    instructions: "You are Mei Ling Tan, booking code T4M8RA, last name Tan. Four of you were on a cancelled flight to Hong Kong today. You want the earliest flight that fits all four of you together. Ask whether any flight has seats for all of you.",
    rubric: [
      { name: "Fits the whole party", criteria: "Only offers flights with enough seats for all four passengers. Never suggests splitting the family." },
      NO_INVENTION,
    ],
  },
  {
    name: "Refund instead of rebooking",
    instructions: "You are Priya Raman, booking code R2D5VK, last name Raman. Your flight to Hong Kong today was cancelled. You no longer want to travel and want your money back.",
    rubric: [
      { name: "Refund rights stated", criteria: "States that the passenger is entitled to a full refund including taxes and fees to the original payment method, and mentions the free-change alternative." },
      { name: "Refund completed", criteria: "Processes the refund and gives a refund reference, read letter by letter." },
      NO_INVENTION,
    ],
  },
  {
    name: "Three failed verifications go to a person",
    instructions: "You want to change a flight. When asked for your booking code, give a wrong one each time: first ZZZ999 with last name Smith, then AAA111 with Smith, then BBB222 with Smith. Then wait for what the assistant does.",
    rubric: [
      { name: "Escalates", criteria: "After the third failed attempt the assistant stops asking and connects the caller to a person or offers a callback from a person." },
      { name: "No data leak", criteria: "Never reveals any booking details for the wrong codes." },
    ],
  },
  {
    name: "Baggage question from policy",
    instructions: "You have a general question: how much checked baggage can you bring in economy on Nimbus Air? You don't need to change anything.",
    rubric: [
      { name: "Policy answer", criteria: "Says 30 kg of checked baggage in economy (and may mention 7 kg cabin baggage), without asking for a booking." },
      NO_INVENTION,
    ],
  },
  {
    name: "Asks for a person",
    instructions: "You are frustrated and immediately say: I want to speak to a human agent, now.",
    rubric: [{ name: "Routes to a person", criteria: "Does not argue or keep the caller with the bot: starts a transfer to a person, or offers a callback from a person if no one is available." }],
  },
  {
    name: "Mandarin speaker",
    instructions: "You speak only Mandarin Chinese. Say: 你好，我的航班取消了，可以用中文帮我吗？ and continue in Chinese.",
    rubric: [{ name: "Continues in Chinese", criteria: "The conversation continues in Mandarin Chinese, from the Mandarin desk." }],
  },
];

async function create() {
  const existing = await api("GET", `/ai/assistants/tests?page%5Bsize%5D=100`).catch(() => []);
  const list = Array.isArray(existing) ? existing : existing.data ?? [];
  for (const t of TESTS) {
    const body = { ...t, destination: ASSISTANT, telnyx_conversation_channel: "web_chat", max_duration_seconds: 240, test_suite: SUITE };
    const found = list.find((x) => x.name === t.name);
    const saved = found ? await api("PUT", `/ai/assistants/tests/${found.test_id ?? found.id}`, body) : await api("POST", "/ai/assistants/tests", body);
    console.log(found ? "updated" : "created", t.name, saved.test_id ?? saved.id);
  }
}

async function run() {
  const started = await api("POST", `/ai/assistants/tests/test-suites/${SUITE}/runs`, {});
  console.log("suite run", JSON.stringify(started).slice(0, 300));
  const tests = (await api("GET", `/ai/assistants/tests?page%5Bsize%5D=100`)).filter?.((x) => x.test_suite === SUITE) ?? [];
  const deadline = Date.now() + 12 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    rows = [];
    for (const t of tests) {
      const runs = await api("GET", `/ai/assistants/tests/${t.test_id ?? t.id}/runs?page%5Bsize%5D=1`);
      const last = (Array.isArray(runs) ? runs : runs.data ?? [])[0];
      rows.push({ name: t.name, status: last?.status, run: last });
    }
    const pending = rows.filter((r) => !["passed", "failed", "error", "completed"].includes(String(r.status)));
    console.log(new Date().toISOString().slice(11, 19), rows.map((r) => `${r.status}`).join(" "));
    if (!pending.length) break;
  }
  const lines = [`# Scenario test run ${new Date().toISOString()}`, "", "| Test | Status | Conversation |", "|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.status} | ${r.run?.conversation_id ?? ""} |`), "", "## Details", ""];
  for (const r of rows) lines.push(`### ${r.name}`, "", "```", JSON.stringify(r.run?.details ?? r.run?.logs ?? r.run ?? {}, null, 2).slice(0, 3000), "```", "");
  const file = `docs/evidence/tests-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  writeFileSync(file, lines.join("\n"));
  console.log("saved", file);
}

const mode = process.argv[2] ?? "all";
if (mode === "create" || mode === "all") await create();
if (mode === "run" || mode === "all") await run();

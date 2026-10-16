#!/usr/bin/env node
// Scenario tests on Telnyx's built-in assistant testing: a simulated caller with instructions,
// graded against a rubric. Creates or updates each test by name in one suite, runs the suite,
// waits for results, and writes them to docs/evidence/.
// Usage: source scripts/env.sh && node scripts/tests.mjs [create|run|normal|all]
import { writeFileSync } from "node:fs";

const API = "https://api.telnyx.com/v2";
const H = { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "content-type": "application/json" };
const ASSISTANT = "assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b";
const MANDARIN_DESK = "assistant-7b3cda63-812a-47b3-8509-1dc9db898dcd";
const SUITE = "disruption-desk";
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 500)}`);
  const j = t ? JSON.parse(t) : {};
  return j.data ?? j;
};

// The grader sees the transcript, not tool calls, so rubrics check facts against the seed data
// instead of asking where a fact came from.
const NO_INVENTION = { name: "Real flights only", criteria: "Any replacement flight offered is a Nimbus Air flight (N B 860, 862, 864, 866 or 868) from Singapore to Hong Kong on a later day, departing 7:10 AM, 9:15 AM, 11:45 AM, 2:30 PM or 8:05 PM. No other flight numbers or times appear." };
const PHONE_MANNER = { name: "Phone manner", criteria: "Short turns, one question at a time, never offers more than three choices in one turn." };
const DATE_THEN_TIME = { name: "Date, then time", criteria: "Asks which date the caller wants (offering dates) before offering any departure times, then offers times on the chosen date." };

const TESTS = [
  {
    name: "Cancelled flight: verify, rebook, confirm",
    // Each test uses its own booking: the suite runs tests in parallel against shared state.
    instructions: "You are Jun Ong. Your Nimbus Air flight from Singapore to Hong Kong today was cancelled because of the typhoon. Your booking code is K7Q2ZX and your last name is Ong. Ask to rebook. When asked which day, choose the second day offered; when offered times, choose the earliest. Say yes clearly when asked to confirm. Write down the confirmation code.",
    rubric: [
      { name: "Verifies first", criteria: "Asks for the booking code and last name before changing anything." },
      DATE_THEN_TIME,
      { name: "Free change", criteria: "Says the change is free (waived because of the typhoon or the cancellation) and never asks the caller to pay a change fee." },
      { name: "Holds then confirms", criteria: "Holds seats on the chosen flight, reads back the flight, date, time and passengers, and asks for a clear yes before confirming." },
      { name: "Code read back", criteria: "Says the booking code stays the same and reads it letter by letter." },
      NO_INVENTION, PHONE_MANNER,
    ],
  },
  {
    // An unaffected route on the typhoon day: the waiver doesn't apply, so the change has a fee.
    name: "Cancel an operating flight: 100 dollar refund",
    // Its own suite on a normal day: on a typhoon day Hughes's Tokyo flight is the only operating
    // booking, and the 100 dollar change test above uses it.
    suite: "disruption-desk-normal",
    instructions: "You are Daniel Hughes, booking code H8N6CU, last name Hughes. Your trip to Tokyo is off and you want to cancel your flight. Say yes clearly when asked to confirm the cancellation. Ask them to repeat the reference once.",
    rubric: [
      { name: "Refund amount", criteria: "Says the cancellation refunds 100 Singapore dollars to the original card, before asking the caller to confirm." },
      { name: "Cancelled", criteria: "Confirms the booking is cancelled and gives a reference, read letter by letter." },
      { name: "No travel credit", criteria: "Never offers travel credit instead of the refund." },
      PHONE_MANNER,
    ],
  },
  {
    name: "Normal change costs 100 dollars",
    instructions: "You are Daniel Hughes, booking code H8N6CU, last name Hughes. Your flight from Singapore to Tokyo is operating normally but you want to fly on a different day. You want the assistant to make the change, not a person: don't ask to speak to anyone. When asked which day, choose the first day offered that isn't today; when offered times, choose the latest one offered. Accept the change fee and say yes clearly when asked to confirm.",
    rubric: [
      DATE_THEN_TIME,
      { name: "Fee quoted", criteria: "States a change fee of 100 Singapore dollars before asking the caller to confirm, and repeats it in the read-back or the confirmation." },
      { name: "Real flights only", criteria: "Any flight offered is a Nimbus Air flight from Singapore to Tokyo (N B 802, 804 or 806), departing 8:40 AM, 12:20 PM or 3:05 PM." },
      { name: "Code read back", criteria: "Says the booking code stays the same and reads it letter by letter." },
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
    instructions: "You are Priya Raman, booking code R2D5VK, last name Raman. Your flight to Hong Kong today was cancelled. You do NOT want to travel and want your money back. Refuse any offer to move to another flight, hold seats or rebook: keep saying you want the full refund. When the assistant asks whether to process the refund, say yes clearly. Stay on the line until the refund is done and write down the refund reference.",
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
    ],
  },
  {
    name: "Asks for a person",
    instructions: "You are frustrated and immediately say: I want to speak to a human agent, now.",
    rubric: [{ name: "Routes to a person", criteria: "Does not argue or keep the caller with the bot: starts a transfer to a person, or offers a callback from a person if no one is available." }],
  },
  {
    // The assistant-edge handoff between the two assistants is a telephony path: in chat the
    // edge either doesn't fire or the desk never gets a turn (DEBUGLOG #17), so this test
    // targets the Mandarin desk directly. The handoff itself is covered by the workflow config
    // and the demo on a phone call.
    name: "Mandarin speaker",
    destination: MANDARIN_DESK,
    instructions: "You speak only Mandarin Chinese. Say: 你好，我的航班取消了，可以用中文帮我吗？ When asked for your booking details, give booking code L9W3PE and last name Lim. Each turn, move the conversation forward in Mandarin: ask about the options for your cancelled flight, then about the cost or the timing of whichever option they mention. Never switch to English and never end the conversation yourself.",
    rubric: [{ name: "Continues in Chinese", criteria: "The replies are in Mandarin Chinese and help with the caller's request (acknowledging the cancellation, asking for details, or offering options), rather than repeating a transfer line or switching to English." }],
  },
];

async function create() {
  const existing = await api("GET", `/ai/assistants/tests?page%5Bsize%5D=100`).catch(() => []);
  const list = Array.isArray(existing) ? existing : existing.data ?? [];
  for (const t of TESTS) {
    const { suite, ...rest } = t;
    const body = { ...rest, destination: t.destination ?? ASSISTANT, telnyx_conversation_channel: "web_chat", max_duration_seconds: 300, test_suite: suite ?? SUITE };
    const found = list.find((x) => x.name === t.name);
    const saved = found ? await api("PUT", `/ai/assistants/tests/${found.test_id ?? found.id}`, body) : await api("POST", "/ai/assistants/tests", body);
    console.log(found ? "updated" : "created", t.name, saved.test_id ?? saved.id);
  }
}

async function run(suite = SUITE, scenario = "typhoon") {
  // Every test mutates shared bookings, so each suite run starts from a fresh scenario load.
  // Skipping this once made a refund test grade a booking the previous run had already refunded.
  const reset = await fetch(`${process.env.OPS_URL ?? "https://desk-ops-68bad318-0.telnyxcompute.com"}/api/scenario`, {
    method: "POST", headers: { authorization: `Bearer ${process.env.DESK_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: scenario }),
  });
  console.log("scenario reset", reset.status);
  // After a reload the SQL database once answered every query in 85-100 s for a minute and a half,
  // and every test failed on a booking-system timeout. Start only once a read is quick again.
  for (let i = 0; i < 24; i++) {
    const t0 = Date.now();
    const ok = await fetch("https://desk-pss-0c8faf8c-0.telnyxcompute.com/v1/bookings/K7Q2ZX", { headers: { authorization: `Bearer ${process.env.PSS_API_KEY}` }, signal: AbortSignal.timeout(5_000) }).then((r) => r.ok).catch(() => false);
    if (ok && Date.now() - t0 < 2_000) break;
    console.log("reservation system slow after the reset, waiting");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const started = await api("POST", `/ai/assistants/tests/test-suites/${suite}/runs`, {});
  console.log("suite run", JSON.stringify(started).slice(0, 300));
  const tests = (await api("GET", `/ai/assistants/tests?page%5Bsize%5D=100`)).filter?.((x) => x.test_suite === suite) ?? [];
  const deadline = Date.now() + 12 * 60_000;
  let rows = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    rows = [];
    for (const t of tests) {
      // The testing API occasionally answers 503 while it is congested; treat that as pending.
      const runs = await api("GET", `/ai/assistants/tests/${t.test_id ?? t.id}/runs?page%5Bsize%5D=1`).catch(() => []);
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
// The normal-day suite (the voluntary cancel): node scripts/tests.mjs normal
if (mode === "normal" || mode === "all") await run("disruption-desk-normal", "normal");

# Nimbus Air Disruption Desk — the demo story

A phone line for an airline that works on a normal day and holds up when a typhoon cancels every
flight to Hong Kong at once. This doc is the feature tour: what to show, in what order, and what
each feature is for. The architecture deep-dive lives in [TECHNICAL.md](TECHNICAL.md); demo-day
Q&A prep in [QA.md](QA.md).

## The product, in one paragraph

Nimbus Air's passengers call one number. The assistant recognises them by phone number, tells
them what happened to their flight, moves them to a real seat without overselling, calls them
back instead of leaving them on hold, and hands them to a person when they need one. Behind it:
four Edge Functions, stateful actors with alarms, KV, object storage and a SQL reservation
system — all on Telnyx Edge Compute, built end-to-end through Telnyx Inference in OpenCode.

## The demo flow, step by step

### 1. A normal day (the "Normal day" button)

All flights on time. The assistant is a service desk:

- **It recognises the caller.** Dial from the verified number (or the browser widget) and it
  greets Jun by name and knows his booking — no code, no verification.
- **The choices come first.** The verbatim opening ends with what the desk can do, worded by the
  webhook for this caller (`opening_offer`): rebook, cancel, or a person. An unknown caller hears
  the same choices without the name.
- **It answers only from tools.** Flight status comes from the reservation system; policy
  questions from `get_policy`, which reads the policy documents out of object storage. Ask it
  something not in the documents and it says so instead of inventing.
- **Voluntary changes work, for a fee**: pick a day, then a time, and hear the 100 Singapore
  dollar change fee (one flat fee per booking, whichever flight) before the yes; hold seats,
  confirm, and hear that the booking code stays the same, read letter by letter.
- **Voluntary cancels keep the fare as credit**: on an operating flight the fare isn't refunded;
  the assistant explains that, offers a change instead, and on a yes cancels and reads a travel
  credit reference (`CR…`, valid 12 months). The seats go back on sale.

### 2. The typhoon (the "Influx day" button)

One click loads the typhoon scenario: all five of today's Hong Kong flights are cancelled in the
reservation system, the greeting speaks the incident notice, the opening offers a known caller a
free rebooking or a full refund, and refund rights unlock.

- **The refund path.** The caller says they want to cancel. Their flight was cancelled by
  Nimbus, so the assistant reads the refund-rights statement verbatim, processes the refund, and
  reads the refund reference letter by letter, with the timeline.
- **Rebooking under contention.** The caller picks a day in the next week, then a time;
  the change is free under the Typhoon Koinu waiver. Seats are real: a family of four is
  held all-or-nothing, a hold that expires frees the seat again, and the desk can only hold a
  flight it could have offered. The caller hears the flight, date, time, passengers by name and
  the fee before anything is confirmed.
- **Waitlist + automatic callback.** When nothing fits, the caller joins the waitlist. Press
  "free 1" on the departures board: the Flight actor's alarm offers the freed seat, and the Trip
  actor places a real outbound AI call to the passenger — "a seat opened up and it is held for
  you." That callback is the emotional beat of the demo.
- **A human when needed.** Ask for a person and the workflow's handoff gate checks the queue
  deterministically: free agent → warm transfer with a summary the agent hears first; no agent →
  a callback booked within two hours. Three failed verifications lock the caller out and route
  to a person. Five minutes in, the call offers a human on its own.
- **Mandarin desk.** Speak Chinese and the workflow hands off to a second assistant — its own
  persona, model, Mandarin voice and transcription, and its own tool set (no refunds or
  cancellations).

### 3. The surge (200 callers at once)

The influx button also starts the surge: 200 simulated passengers rebooking through the same
MCP tools the phone assistant calls (`find_dates` → `find_flights` → `hold_seats` →
`confirm_rebooking`), in waves, while the console watches seats drain live.
Watch on the dashboard:

- **Live calls ticker** — one panel per active call, showing its flow (webhook → verify →
  dates → flights → hold → confirm) as it happens, with latency per hop.
- **Departures board** — the Hong Kong flights for today and the next two days, plus the relief
  flight: seats left, held and waitlist counts updating live; races lost and retried.
- **KPIs** — rebooked, waitlisted, seat races lost, tool errors (1 min).
- **Canary** — a synthetic probe every 60 seconds calls the webhook, `tools/list` and a real
  tool call the way Telnyx does; the health pill goes red within 90 seconds if anything breaks.
- **Trace waterfall** — click any trace to see one call's path across webhook → KV → actors →
  MCP → reservation system, keyed by Telnyx's own trace id.

The stampede proof backs it up: 300 concurrent holds on a 60-seat flight grant exactly 60
through the actor, while a naive KV read-check-write grants 300 and records 1. The actor
serialises; last-write-wins oversells.

### 4. Ops controls (no redeploy needed)

- **Flags**: disruption mode, human queue (full → callback offers instead of transfers), hold
  length (45 s makes hold expiry visible live). Flipped from the console, applied on the next
  call, and synced into the assistants' defaults so calls route correctly even when the webhook
  is late.
- **Relief flight**: ops adds a 300-seat NB870 tomorrow from the console.
- **Filler speech**: during any tool call the assistant says a short line ("Let me check that
  for you") before it works — the caller never hears dead air.

## The features list

| # | Feature | Where |
|---|---|---|
| 1 | Phone line + browser widget on the same assistant | README "Try it" |
| 2 | Caller recognition by phone; code+name verification for unknown callers | `desk-dv`, `verify_booking` |
| 3 | 14-node, 41-edge conversation workflow: speak, prompt and tool nodes; LLM, expression and default edges | `assistant/flow.mjs` |
| 4 | Multi-assistant routing to a Mandarin desk (own model, voice, STT, tools) | `assistant/build.mjs` |
| 5 | 11-tool MCP server with server-side business rules (date then time, hold only what was offered, fee computed on the server) | `desk-mcp` |
| 6 | Dynamic-variables webhook that answers inside the platform's ~1.2 s cutoff, with graceful fallback | `desk-dv` |
| 7 | Live seat inventory: holds with expiry, all-or-nothing families, no overselling | `Flight` actor |
| 8 | Per-passenger case state across calls: holds, rebookings, refunds, cancellations, waitlist, callbacks | `Trip` actor |
| 9 | Waitlist with actor-alarm seat offers and real outbound AI callbacks | `Flight` + `Trip` alarms |
| 10 | Human handoff: deterministic queue gate, warm transfer, callback fallback, 3-strikes lockout, 5-minute timer | flow tool nodes + `desk-ops /api/queue` |
| 11 | Refunds, and voluntary cancels refunding a sample 100 Singapore dollars, with the reference read letter by letter; eligibility enforced server-side | `request_refund`, `cancel_booking` |
| 12 | Itinerary receipts and policy documents in object storage | `desk-mcp` `DOCS` binding |
| 13 | Feature flags without a redeploy, synced into assistant defaults | `Config` actor + `desk-ops` |
| 14 | Ops console: departures board, KPIs, passengers, callback queue, trace waterfall, live call ticker | `desk-ops` |
| 15 | Surge simulator: 200 concurrent passengers through the real tools, with live progress and latency percentiles | `Surge` actor |
| 16 | Canary: a synthetic probe every 60 s, health pill, "tool errors (1 min)" tile | `Canary` actor |
| 17 | Distributed tracing: one trace id (Telnyx's own `traceparent`) across every hop | `shared/log.ts` |
| 18 | Stampede lab: the actor-vs-KV overselling proof, runnable from the console | `desk-ops /lab/*` |
| 19 | Dead-air engineering: model-behaviour fillers before tool calls, eager end-of-turn, a measured model choice | DEBUGLOG #18–#19 |
| 20 | Scenario suite: 8 rubric-graded chat tests (the 7-test suite ran 7/7 on Oct 11) | `scripts/tests.mjs` |
| 21 | Change fee: 100 Singapore dollars per booking, waived under the typhoon waiver or after a Nimbus cancellation; quoted before the yes, charged on confirm | `shared/fees.ts` |
| 22 | Voice test harness: AI-to-AI calls over SIP, six scenarios on the real voice pipeline, no phone needed | `scripts/voice-test.mjs` |
| 23 | Opening worded per caller: the choices (rebook, cancel, a person) at pickup | `desk-dv` `opening_offer` |

## What we'd show if we only had five minutes

1. Call the number (or the widget) on a normal day — recognise, answer from tools.
2. Load the typhoon, call again — incident notice, refund with the reference spelled out.
3. One more click: the surge — watch the board drain, the ticker move, the canary stay green.
4. Free a seat — the waitlisted passenger's phone rings.

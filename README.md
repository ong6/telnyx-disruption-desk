# Nimbus Air Disruption Desk

A phone line for an airline that works on a normal day and holds up when a typhoon cancels every
flight to Hong Kong at once. It recognises the caller, tells them what happened, moves them to a
real seat without overselling, calls them back instead of leaving them on hold, and hands them to
a person when they need one.

Built on Telnyx Voice AI (Conversation Workflows, multi-assistant routing, transfer) and Telnyx
Edge Compute: four Edge Functions, Stateful Actors with alarms, KV, Cloud Storage and a SQL
database. Nimbus Air is fictional.

**Docs:** the feature tour for the demo is [docs/FEATURES.md](docs/FEATURES.md); the technical
deep dive is [docs/TECHNICAL.md](docs/TECHNICAL.md); demo-day Q&A prep with one talking point
per requirement is [docs/QA.md](docs/QA.md).

## Try it

| What | Where |
|---|---|
| **Talk to it in your browser** | The ops console's *Talk to the desk* button (a WebRTC call to the same assistant) |
| Call the desk | **+1 743 888 2787**. This runs on a Telnyx trial account, which only accepts calls from its verified number, so the phone line is shown live on demo day and the browser call works for everyone else |
| Ops console (live seats, calls, traces, health) | https://desk-ops-68bad318-0.telnyxcompute.com |
| MCP server (Streamable HTTP, POST only) | https://desk-mcp-299d7f49-1.telnyxcompute.com/mcp |
| Dynamic variables webhook | https://desk-dv-da3c8445-f.telnyxcompute.com |
| Reservation system API (mock, partner key) | https://desk-pss-0c8faf8c-0.telnyxcompute.com |

Bookings to try when calling from an unrecognised number (say the code, then the last name):

| Booking | Last name | What happens |
|---|---|---|
| `T4M8RA` | Tan | Family of four on a cancelled flight: seats are held all-or-nothing |
| `L9W3PE` | Lim | Wheelchair assistance on the booking: goes straight to a specialist |
| `R2D5VK` | Raman | Platinum, two passengers, cancelled flight |
| `H8N6CU` | Hughes | Tokyo flight, not affected: normal-day questions; a change costs 100 Singapore dollars, a cancel keeps the fare as travel credit |

The demo caller's own number is recognised by caller ID and greeted by name.

The schedule runs seven days from today, the same every day: Singapore → Hong Kong NB860 07:10,
NB862 09:15, NB864 11:45, NB866 14:30 and NB868 20:05; Singapore → Tokyo NB802 08:40, NB804
12:20 and NB806 15:05. The typhoon cancels all of today's Hong Kong flights, and tomorrow's
NB860 is full, for the waitlist.

## Architecture

![Architecture](docs/architecture.svg)

```
                   ┌──────────────────────────── Telnyx AI Assistant: Disruption Desk ───────────────────────────┐
 Caller ──PSTN──▶  │ opening ─▶ triage ─┬──▶ rebook: date, then time ─▶ confirm ─▶ wrap up                        │
                   │ (speak)   (prompt) ├──▶ cancel ─▶ travel credit, or refund rights (speak) ─▶ refund          │
                   │                    ├──▶ status & policy                                                      │
                   │                    ├──▶ handoff gate (tool) ─▶ transfer │ callback                           │
                   │                    └──▶ Mandarin Desk (second assistant)                                     │
                   └───────┬──────────────────────────────────────────┬───────────────────────────────────────────┘
       assistant.initialization│ (signed)                     MCP tools/call│ (bearer + traceparent)
                           ▼                                              ▼
                  ┌──────────────────┐   shared actors     ┌───────────────────────────────┐
                  │ desk-dv          │ ─────────────────▶  │ desk-mcp                      │
                  │ webhook: who is  │                     │ MCP server, owns the actors:  │
                  │ calling, flags,  │                     │  Flight (per flight + date)   │
                  │ case, mcp_token  │                     │  Trip (per booking)           │
                  └──────┬───────────┘                     │  CallSession (per call)       │
                         │                                 │  Metrics (counters)           │
                         │        ┌──────────────┐         └────────┬──────────────┬───────┘
                         └──────▶ │ desk-pss     │ ◀────────────────┘              │
                                  │ reservation  │  REST, partner key      Cloud Storage
                                  │ system mock  │                         (policies, receipts)
                                  │ (SQL DB)     │
                                  └──────────────┘
                  ┌──────────────────────────────────────────────────────────┐
                  │ desk-ops: console, scenarios, flags, relief flight,      │
                  │ canary actor (every 60 s), trace viewer, stampede lab    │
                  └──────────────────────────────────────────────────────────┘
                  KV: flags, active scenario, trace spans, outbound-call config
```

## Which primitive, and why

| State or job | Primitive | Why not the others |
|---|---|---|
| Seats, holds and waitlist per flight | **Actor `Flight`** | Hundreds of callers race on the same seats. The actor runs one call at a time, so read-modify-write needs no lock. KV is last-write-wins with no compare-and-swap; the stampede test below shows it overselling |
| One passenger's case across calls (held, rebooked, refunded, waitlisted, callback) | **Actor `Trip`** | Per-entity state that both the webhook (greet "welcome back") and the MCP server (change it) touch: a shared actor |
| One call's verified booking and failed attempts | **Actor `CallSession`** | Read on every tool call, must be consistent and fast; KV reads measured at over a second |
| Live counters, recent calls, callback queue | **Actor `Metrics`** | Concurrent increments; KV would lose them |
| Synthetic probe every minute | **Actor `Canary`** with an alarm | Edge Functions have no cron; an actor alarm re-arms itself |
| Disruption mode, human queue, hold length | **KV flags** | Read on every call, written rarely by one operator; stale for 10 s is fine; flipped from the console without a redeploy |
| Trace spans | **KV**, one key per span | Append-only, written without waiting, read only when someone opens a trace |
| Bookings and schedule | **SQL database** behind `desk-pss` | Stands in for the airline's own reservation system, which this product doesn't own |
| Policy documents, itinerary receipts | **Cloud Storage** (ap-southeast-1) | Documents, not keys |
| Option ranking, change fee, voice formatting, eligibility | **Plain function code** | Pure functions of their inputs |

Correctness never depends on an alarm firing: holds carry `expiresAt` and are expired on every read.
The alarm frees the seat promptly and offers it to the waitlist.

## The conversation workflow

14 nodes and 41 edges (27 LLM, 9 expression, 5 default), built as data in
[`assistant/flow.mjs`](assistant/flow.mjs) and applied with
[`assistant/build.mjs`](assistant/build.mjs).

| Node | Type | What it does | Leaves when |
|---|---|---|---|
| `n_open` | speak | Recording and automated-assistant disclosure, `{{incident_notice}}` (empty on a normal day), then `{{opening_offer}}`: the choices, verbatim | default |
| `n_triage` | prompt, append, no tools | Only picks a transition; if the need isn't clear, asks one question: rebook, cancel, or a person? | `special_assistance == "true" && human_queue == "open"` → specialist (expression); rebook / cancel / status / Mandarin (LLM) |
| `n_rebook` | prompt, append, MCP | Verify if needed; the date first (`find_dates`), then up to three times that day (`find_flights`); hold; read back the flight, passengers and change fee | held and yes → confirm; nothing fits → waitlist; would rather cancel → cancel |
| `n_confirm` | prompt, append, MCP | Confirm, read the code back letter by letter, with the change fee | done → wrap up; hold expired → rebook |
| `n_cancel` | prompt, append, MCP | Verify. If Nimbus cancelled or delayed the flight, go to refund rights; otherwise explain travel credit (12 months) or a change for the fee, and `cancel_booking` on a yes | disrupted → refund rights; changes their mind → rebook; done → wrap up |
| `n_refund_rights` | speak | Refund-rights statement, verbatim | default |
| `n_refund` | prompt, append, MCP | Refund, or explain why not and offer a change | done → wrap up; changed mind → rebook |
| `n_waitlist` | prompt, append, MCP | Waitlist plus automatic callback; hotel and meal voucher | done |
| `n_faq` | prompt, append, MCP | Flight status and policy, from tools only | rebook / cancel / done → wrap up |
| `n_handoff_gate` | tool (`check_human_queue`) | Asks `desk-ops` whether a person is free, with no model turn | `telnyx_last_tool_status_code == "200"` (calls) or `== 200` (chat), one edge each → transfer; default → callback |
| `n_human`, `n_specialist` | tool (transfer) | Warm transfer; the agent hears a summary first | default → callback, only if the transfer fails |
| `n_callback` | prompt, MCP | Book a callback from a person | done |
| `n_wrap` | prompt, hangup tool | Anything else? Goodbye | — |

Every conversational node can reach a person: when the caller asks (LLM), after three failed
verifications (the MCP server locks verification for that call and the assistant hands over), or
after five minutes (`telnyx_conversation_duration_secs >= 300`). Confirm and wrap-up are exempt
from the timer, so a booking or a goodbye is never turned into a transfer.

**The opening.** `opening_offer` comes from the webhook, worded for what we know about the caller,
so everyone hears the choices at pickup. A known caller on the typhoon day hears "Hi Jun. Your
flight to Hong Kong is cancelled. I can rebook you onto another flight for free, cancel it for a
full refund, or connect you with a person. What would you like to do?" An unknown caller hears
the anonymous version, which is also the assistant's default variable.

**Variable comparisons vs LLM conditions.**
- **Facts our systems already know route deterministically:** special assistance, the human queue
  (via the gate's status code) and call length.
- **What the caller wants is routed by the LLM.**
- **A timing gotcha.** On a call, a prompt node's expression edges run when the caller next speaks.
  So deterministic hops that must happen *now* use speak or tool nodes, which advance on their own
  (DEBUGLOG #12).
- **On a call, an LLM edge is a tool.** Telnyx offers each one to the model as
  `transition__<edge id>`, and it fires only if the model calls it; chat judges edges in a
  separate call. An edge id with a colon, 72 characters with the prefix, broke the
  `[A-Za-z0-9_-]{1,64}` tool-name rule and made every model turn on a call fail while every chat
  test passed (DEBUGLOG #21). Edge ids are now short (`triage_mandarin`), `tests/flow.test.ts`
  checks them, and node instructions say when to call each transition.

**Append vs replace.** Every node appends to the base prompt (persona, phone manner, "only offer
flights a tool returned"), so those rules hold everywhere.

**Tool scoping.**
- **Shared tools are scoped per node.** `hangup` exists only on wrap-up. Transfer is reachable
  only through the tool nodes behind the handoff gate, so the model can't transfer around the
  human-queue check.
- **MCP tools are assistant-wide on Telnyx.** Node tool modes don't remove them (DEBUGLOG #4), so
  the MCP server enforces the business rules itself: no confirm without a live hold, no change
  without a verified booking, no hold on a flight `find_flights` couldn't have offered (another
  route, the original flight, or one leaving within 90 minutes), no refund unless the flight was
  disrupted.
- **The change fee is computed on the server** ([`shared/fees.ts`](shared/fees.ts)): 100 Singapore
  dollars per booking, the same for every option, and waived under the Typhoon Koinu waiver (the
  typhoon scenario, on a route through Hong Kong) or when Nimbus cancelled the original flight.
  `find_dates`, `find_flights` and `hold_seats` quote it; `confirm_rebooking` charges it, on the
  receipt and in the reservation system's change log.

## Proof: 300 callers, 60 seats

`node scripts/stampede.mjs 300 60` sends 300 concurrent seat holds at a 60-seat flight, once
through the `Flight` actor and once through a naive KV read-modify-write
([raw output](docs/evidence/stampede-2026-10-10-15-45.txt)):

| Path | Seats granted | Store says held | Oversold |
|---|---|---|---|
| Actor `Flight.hold()` | 60 | 60 | 0 |
| KV read, check, write | 300 | 1 | 240 |

KV told every caller they had a seat and recorded one: last write wins. The actor serialises the
300 requests (about 28 ms each), so no lock is needed.

This proves backend contention, not 300 live phone calls. Call concurrency is the platform's job,
and the trial account caps outbound calls at 2.

## Scenario suite status

Telnyx's assistant-test runner is chat-only, and chat is not the product channel: across the
afternoon the same seven tests passed in rotating combinations while the fixes landed and the
simulated caller's turn-taking varied (DEBUGLOG #8, #17). The final run on the finished build is
[7/7](docs/evidence/tests-2026-10-11-08-25.md); [the
summary](docs/evidence/suite-summary-2026-10-11.md) shows every run and what it taught, and the
canary — which watches the real phone path — stayed green throughout.

Two suites now, because chat passed while every call hung (DEBUGLOG #21):

- **Chat** (`node scripts/tests.mjs`): 8 rubric-graded tests. New since the 7/7 run: *Normal
  change costs 100 dollars* (Daniel, Tokyo route), and rubrics that check the date is asked
  before the time.
- **Voice** (`node scripts/voice-test.mjs`): AI-to-AI calls over SIP. A *Nimbus test caller*
  assistant phones the desk's SIP address, so each scenario runs the real voice pipeline
  (speech-to-text, transitions as tool calls, text-to-speech) with no phone. Scenarios:
  `rebook-typhoon`, `rebook-fee`, `cancel-refund`, `cancel-credit`, `person` (human queue set to
  full, so it ends in a callback and nothing dials a real phone) and `mandarin`. Results go to
  `docs/evidence/voice-*.md`.

Results on the finished build (Oct 12–13; Telnyx KV was failing on and off at the time, DEBUGLOG #23):

| Path | Voice (AI-to-AI call) | Chat |
|---|---|---|
| Typhoon rebook: date, then time, free under the waiver, hold, confirm | pass ([run](docs/evidence/voice-2026-10-12-16-34.md)) | fail: shared chat sessions mixed two bookings (see the note below the table) |
| Normal-route change: 100 dollar fee, then confirm | pass ([run](docs/evidence/voice-2026-10-12-17-01.md)) | fail: ran on a booking the voice run had already changed |
| Cancel a typhoon-cancelled flight: refund rights read verbatim, then refund | pass | pass |
| Cancel an operating flight: travel credit | pass | — |
| Mandarin handoff | pass | pass (desk direct) |
| Family of four, three failed verifications, baggage policy, ask for a person | — | pass ([run](docs/evidence/tests-2026-10-12-17-05.md)) |
| Ask for a person on a call: queue open → transfer (the transfer pointed at an AI for the test); transfer fails or queue can't be checked → callback | pass (DEBUGLOG #24) | pass |

The chat suite's scenario reset failed on that run (KV), so two tests ran on state the voice runs had
already changed. One chat conversation also shows tool calls acting on two different bookings,
which points at chat sessions sharing MCP identity across parallel tests; it is open (DEBUGLOG #25).

## How it meets the brief

| Requirement | Where |
|---|---|
| Assistant with a multi-node Conversation Workflow, speak nodes, conditional edges | [`assistant/flow.mjs`](assistant/flow.mjs): 14 nodes (prompt, speak, tool) and 41 edges (expression, LLM and default) |
| Callable by phone | +1 743 888 2787 (TeXML app assigned by `build.mjs`) |
| Custom MCP server, at least 3 tools | `desk-mcp`: 11 tools (`verify_booking`, `get_trip_status`, `find_dates`, `find_flights`, `hold_seats`, `confirm_rebooking`, `request_refund`, `cancel_booking`, `join_waitlist`, `request_callback`, `get_policy`) |
| Dynamic webhook variables from an Edge Function, influencing routing | `desk-dv`: caller ID → booking, case and flags; drives `disruption_mode`, `special_assistance` and `human_queue` edges, and words the opening (`opening_offer`) |
| Edge Functions, `telnyx-edge ship` | `functions/desk-{dv,mcp,ops,pss}` |
| KV | Flags and active scenario, trace spans, outbound-call config |
| Stateful Actor, read-modify-write without a lock | `Flight.hold()`; [stampede evidence](docs/evidence/) |
| Observability | Below |
| OpenCode with Telnyx Inference | [DOGFOODING.md](DOGFOODING.md), [`.opencode/`](.opencode/) |

| Stretch goal | Where |
|---|---|
| Multi-assistant routing | `n_triage` → *Mandarin Desk*: its own persona and prompt, a Mandarin voice and speech-to-text, and its own tool set (no refunds or cancellations), with `voice_mode: distinct` |
| Variable comparison edges | `special_assistance && human_queue == "open"`, `telnyx_last_tool_status_code == 200` (handoff gate), `telnyx_conversation_duration_secs >= 300` |
| Alarms in actors | `Flight` (hold expiry, waitlist offers), `Trip` (outbound callback call), `Canary` (every minute) |
| Object storage | Policy documents read by `get_policy` (uploaded with `scripts/upload-policies.mjs`); an itinerary receipt with the change fee written per rebooking (`receipts/<code>.json`) |
| KV feature flags | Disruption mode, human queue, hold length: flipped on the console, no redeploy |
| Shared actors | `Flight`, `Trip`, `CallSession` and `Metrics` are owned by `desk-mcp`, bound by `desk-dv` and `desk-ops` |
| Custom variables that route | `special_assistance` and `human_queue` (from the webhook) route; `incident_notice` and `opening_offer` make the opening; `caller_known` decides whether to verify |
| Distributed tracing | One trace ID, Telnyx's own W3C trace ID, across webhook → KV/actors → MCP → reservation system; waterfall on the console |

## Observability

- **Logs.** One JSON line per event from every function: `ts, svc, trace, op, outcome, ms`. The
  caller's number is masked. Read with `telnyx-edge logs <fn> --tail`.
- **Traces.** Every hop writes a span under the call's trace ID: webhook, reservation-system
  calls and cache hits, each MCP tool. The console draws one call as a waterfall. The trace ID is
  Telnyx's own `traceparent`, so it also matches Telnyx's side.
- **Signals beyond logs.**
  - Per-minute counters and latency (p50/p95) in the `Metrics` actor: calls, rebooked, refunded,
    waitlisted, seat races lost, tool errors.
  - Seats left per flight.
  - The platform's own `telnyx-edge metrics <fn>`.
- **Knowing within a minute.** The `Canary` actor's alarm runs every 60 s: it calls the webhook,
  MCP `tools/list` and a real tool call, the way Telnyx does. The console's health pill goes red
  when the last good probe is older than 90 s or any probe fails, and the "tool errors (1 min)"
  tile counts live failures. The console also reports its own health: how long it took to read
  its state and which subsystems failed to answer, instead of silently rendering blanks — that
  is how a dead actor host showed up as six-second polls before anything else noticed.
- **What I'd look at first.**
  1. The failing call's trace, to see which hop.
  2. `telnyx-edge logs <fn> --type invocations --json`: status, duration, response size and
     region per request. That's how bug #7 was found.
- **Debugging trail.** [DEBUGLOG.md](DEBUGLOG.md): every entry is a real bug with its evidence —
  the count grows as the platform surprises continue.

## Run it yourself

```bash
source scripts/env.sh                  # repo-local telnyx-edge and opencode, .env
telnyx-edge secrets add ...            # DESK_ADMIN_TOKEN, PSS_API_KEY, DESK_MCP_BEARER, DESK_TELNYX_KEY, DEMO_CALLER_NUMBER
for f in functions/*; do (cd $f && npm i && telnyx-edge ship); done   # one at a time: parallel ships get HTTP 429; each takes 6-25 min
node assistant/build.mjs               # MCP server, tools, both assistants, workflow, number
node scripts/upload-policies.mjs       # content/policies → the bucket get_policy reads (--check compares)
curl -X POST $OPS/api/scenario -H "authorization: Bearer $DESK_ADMIN_TOKEN" -d '{"id":"typhoon"}'
node scripts/chat.mjs "Hi, my flight was cancelled" "Find me the earliest flight"
node scripts/voice-test.mjs rebook-fee # one AI-to-AI voice scenario over SIP; no args runs all six
node scripts/stampede.mjs 300 60
npm test
```

Infrastructure (created once): KV namespace `desk-kv`, SQL database `desk-pss`, bucket
`nimbus-desk-*` in ap-southeast-1, the integration secret `desk_mcp_bearer`.

## Limits and what I'd do next

- **Trial account.** It only accepts calls from its verified number and only calls out to it. A
  paid account lifts both.
- **Seat counts are inventory held in actors for the disruption window.** A real deployment would
  receive its inventory allocation from the airline's reservation system and write back
  confirmed changes, as `desk-pss` does here. It would also retry failed write-backs (today they
  are logged as `ticketing: pending`).
- **The `Metrics` actor is a single instance.** At real volume it would be sharded by minute or by
  hash.
- **Chat isn't the product channel.** Telnyx runs the webhook later in chat than on calls
  (DEBUGLOG #6), so the opening branch is tested by phone. Transitions also work differently on
  a call (DEBUGLOG #21), so every workflow change gets a voice run as well as the chat suite.
- **Fees and credit are recorded, not collected.** The change fee is on the receipt and in the
  reservation system's change log, with no payment step, and a travel credit reference isn't
  redeemable by any tool yet.
- **Demo conveniences, named as such.** The ops console's read endpoints (`/api/state`,
  `/api/trace`) now take the operator key; `/api/queue` stays open because the workflow's
  handoff-gate tool node carries no credentials. The admin token is accepted as a `?key=`
  parameter so the console link can be shared with one click. `desk-mcp`'s admin-token path
  (`x-test-booking`) lets the test harness act on any booking — it is guarded by that token.
  `web_calls_as_demo_caller` defaults to off; the operator turns it on for browser demos, and
  every web caller is then treated as the demo passenger until they verify their own booking.
- **Deployed IDs are baked in.** Function URLs live in `shared/endpoints.ts`, assistant and tool
  IDs in `assistant/build.mjs`; a fresh Telnyx org re-runs `build.mjs` and updates those two
  files.

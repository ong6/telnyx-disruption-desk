# Nimbus Air Disruption Desk

A phone line for an airline that works on a normal day and holds up when a typhoon cancels every
flight to Hong Kong at once. It recognises the caller, tells them what happened, moves them to a
real seat without overselling, calls them back instead of leaving them on hold, and hands them to
a person when they need one.

Built on Telnyx Voice AI (Conversation Workflows, multi-assistant routing, transfer) and Telnyx
Edge Compute: four Edge Functions, Stateful Actors with alarms, KV, Cloud Storage and a SQL
database. Nimbus Air is fictional.

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
| `H8N6CU` | Hughes | Tokyo flight, not affected: normal-day questions and changes |

The demo caller's own number is recognised by caller ID and greeted by name.

## Architecture

![Architecture](docs/architecture.svg)

```
                   ┌──────────────────────────── Telnyx AI Assistant: Disruption Desk ───────────────────────────┐
 Caller ──PSTN──▶  │ disclosure ─▶ route ─▶ incident notice ─▶ triage ─▶ rebook ─▶ confirm ─▶ wrap up              │
                   │   (speak)    (expr)      (speak)           │  ├──▶ refund rights (speak) ─▶ refund           │
                   │                                            │  ├──▶ status & policy                           │
                   │                                            │  ├──▶ handoff gate (expr) ─▶ transfer │ callback│
                   │                                            │  └──▶ Mandarin Desk (second assistant)          │
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
| Option ranking, voice formatting, eligibility | **Plain function code** | Pure functions of their inputs |

Correctness never depends on an alarm firing: holds carry `expiresAt` and are expired on every read.
The alarm frees the seat promptly and offers it to the waitlist.

## The conversation workflow

Built as data in [`assistant/flow.mjs`](assistant/flow.mjs) and applied with
[`assistant/build.mjs`](assistant/build.mjs).

| Node | Type | What it does | Leaves when |
|---|---|---|---|
| `n_open` | speak | Recording and automated-assistant disclosure, verbatim | default |
| `n_route` | prompt (silent) | Routing only | `disruption_mode == "on"` → incident notice, else triage |
| `n_incident` | speak | `{{incident_notice}}` from KV, verbatim | default |
| `n_triage` | prompt, append, no tools | Greets a known caller by name, says what happened to their flight, finds the need | `special_assistance == "true" && human_queue == "open"` → specialist (expression); rebook / refund / status / Mandarin (LLM) |
| `n_rebook` | prompt, append, MCP | Verify if needed, offer at most two options, hold seats | held and confirmed → confirm; nothing fits → waitlist; prefers refund |
| `n_confirm` | prompt, append, MCP | Confirm, read the code back letter by letter | done → wrap up; hold expired → rebook |
| `n_refund_rights` | speak | Refund-rights statement, verbatim | default |
| `n_refund` | prompt, append, MCP | Refund, or explain why not and offer a change | done / changed mind |
| `n_waitlist` | prompt, append, MCP | Waitlist plus automatic callback; hotel and meal voucher | done |
| `n_faq` | prompt, append, MCP | Flight status and policy, from tools only | — |
| `n_handoff_gate` | prompt (silent) | Routing only | `human_queue == "full"` → callback, else transfer |
| `n_human`, `n_specialist` | tool (transfer) | Warm transfer; the agent hears a summary first | default → callback, only if the transfer fails |
| `n_callback` | prompt, MCP | Book a callback from a person | done |
| `n_wrap` | prompt, hangup tool | Anything else? Goodbye | — |

Every conversational node can reach a person: when the caller asks (LLM), after three failed
verifications (the MCP server locks verification for that call and the assistant hands over), or
after five minutes (`telnyx_conversation_duration_secs >= 300`). The confirm step is exempt from the timer, so a
booking is never cut off halfway.

**Variable comparisons vs LLM conditions.** Facts our systems already know route
deterministically: disruption mode, special assistance, human queue and call length. Telnyx
evaluates these before the model's turn. What the caller wants is routed by the LLM.

**Append vs replace.** Every node appends to the base prompt (persona, phone manner, "only offer
flights a tool returned"), so those rules hold everywhere.

**Tool scoping.**
- **Shared tools are scoped per node.** `hangup` exists only on wrap-up. Transfer is reachable
  only through the tool nodes behind the handoff gate, so the model can't transfer around the
  human-queue check.
- **MCP tools are assistant-wide on Telnyx.** Node tool modes don't remove them (DEBUGLOG #4), so
  the MCP server enforces the business rules itself: no confirm without a live hold, no change
  without a verified booking, no refund unless the flight was disrupted.

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

## How it meets the brief

| Requirement | Where |
|---|---|
| Assistant with a multi-node Conversation Workflow, speak nodes, conditional edges | [`assistant/flow.mjs`](assistant/flow.mjs): 15 nodes (prompt, speak, tool), expression, LLM and default edges |
| Callable by phone | +1 743 888 2787 (TeXML app assigned by `build.mjs`) |
| Custom MCP server, at least 3 tools | `desk-mcp`: 9 tools (`verify_booking`, `get_trip_status`, `find_alternatives`, `hold_seats`, `confirm_rebooking`, `request_refund`, `join_waitlist`, `request_callback`, `get_policy`) |
| Dynamic webhook variables from an Edge Function, influencing routing | `desk-dv`: caller ID → booking, case and flags; drives `disruption_mode`, `special_assistance` and `human_queue` edges |
| Edge Functions, `telnyx-edge ship` | `functions/desk-{dv,mcp,ops,pss}` |
| KV | Flags and active scenario, trace spans, outbound-call config |
| Stateful Actor, read-modify-write without a lock | `Flight.hold()`; [stampede evidence](docs/evidence/) |
| Observability | Below |
| OpenCode with Telnyx Inference | [DOGFOODING.md](DOGFOODING.md), [`.opencode/`](.opencode/) |

| Stretch goal | Where |
|---|---|
| Multi-assistant routing | `n_triage` → *Mandarin Desk*: its own persona and prompt, a Mandarin voice and speech-to-text, and its own tool set (no refunds), with `voice_mode: distinct` |
| Variable comparison edges | `disruption_mode`, `special_assistance && human_queue`, `human_queue`, `telnyx_conversation_duration_secs >= 300` |
| Alarms in actors | `Flight` (hold expiry, waitlist offers), `Trip` (outbound callback call), `Canary` (every minute) |
| Object storage | Policy documents read by `get_policy`; an itinerary receipt written per rebooking (`receipts/<code>.json`) |
| KV feature flags | Disruption mode, human queue, hold length: flipped on the console, no redeploy |
| Shared actors | `Flight`, `Trip`, `CallSession` and `Metrics` are owned by `desk-mcp`, bound by `desk-dv` and `desk-ops` |
| Custom variables that route | `disruption_mode`, `special_assistance`, `human_queue` |
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
  tile counts live failures.
- **What I'd look at first.**
  1. The failing call's trace, to see which hop.
  2. `telnyx-edge logs <fn> --type invocations --json`: status, duration, response size and
     region per request. That's how bug #7 was found.
- **Debugging trail.** [DEBUGLOG.md](DEBUGLOG.md): eight real bugs, each with its evidence.

## Run it yourself

```bash
source scripts/env.sh                  # repo-local telnyx-edge and opencode, .env
telnyx-edge secrets add ...            # DESK_ADMIN_TOKEN, PSS_API_KEY, DESK_MCP_BEARER, DESK_TELNYX_KEY, DEMO_CALLER_NUMBER
for f in functions/*; do (cd $f && npm i && telnyx-edge ship); done   # one at a time: parallel ships get HTTP 429; each takes 6-25 min
node assistant/build.mjs               # MCP server, tools, both assistants, workflow, number
curl -X POST $OPS/api/scenario -H "authorization: Bearer $DESK_ADMIN_TOKEN" -d '{"id":"typhoon"}'
node scripts/chat.mjs "Hi, my flight was cancelled" "Find me the earliest flight"
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
  (DEBUGLOG #6), so the opening branch is tested by phone.

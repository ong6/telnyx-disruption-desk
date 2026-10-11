# Nimbus Air Disruption Desk — technical deep dive

This is the walkthrough doc for demo-day section 2: architecture, decisions, and the numbers
behind them. Every claim traces to code, evidence or a numbered entry in
[DEBUGLOG.md](../DEBUGLOG.md). The feature tour lives in [FEATURES.md](FEATURES.md).

## 1. Deployment layout

```
Caller (phone) ──▶ Telnyx-managed: AI Assistant + Conversation Workflow
                         │  (nodes, edges, voices, STT — their runtime)
        ┌────────────────┼──────────────────────────┐
        ▼                ▼                          ▼
  desk-dv (webhook)  desk-mcp (MCP)          desk-ops (console/canary)
  answers in <1.2s   9 tools + owns the     watches everything,
  binds identity     four shared actors     never in the call path
        │                │
        └──────▶ desk-pss (mock reservation system + SQL)  ◀── the "airline's system"
```

| Piece | Runs on | Why it is separate |
|---|---|---|
| Assistant, workflow, voices, STT/TTS | Telnyx-managed | It *is* the call; routing must live where the voice pipeline is |
| `desk-dv` — dynamic variables webhook | Edge Function | Contract: Telnyx calls it at call setup and stops waiting at ~1.2 s. Its 900 ms budget must never wait behind MCP work |
| `desk-mcp` — MCP server + `Flight`/`Trip`/`CallSession`/`Metrics` actors | Edge Function + account-scoped actors | The only hop the model calls; business rules live here because the platform cannot scope MCP tools per node |
| `desk-pss` — mock reservation system | Edge Function + SQL | Plays the airline's system of record; a REST boundary with a partner key keeps the integration honest |
| `desk-ops` — console, canary, surge | Edge Function + actors | Must keep working (and watching) when everything else is broken; holds the write-access controls |
| KV (`desk-kv`) | Edge KV | Flags, trace spans, outbound-call config — reads that tolerate staleness |
| Object storage (`nimbus-desk-*`, ap-southeast-1) | Telnyx Cloud Storage | Policy documents, itinerary receipts — documents, not keys |

State is deliberately split three ways: **actors** for per-entity read-modify-write that must
be serialised, **KV** for read-mostly values where 10 s of staleness is fine, **function
memory** for pure calculations (option ranking, spoken formatting).

## 2. Identity and authorisation (the model never decides who it acts on)

- Telnyx sends a W3C `traceparent` whose trace id is the conversation's identity. The webhook
  binds caller number → booking into a `CallSession` actor keyed by that trace id.
- The MCP server resolves each request's trace back to the conversation (link lookup, with
  retries for deploy cutovers) and reads the binding. `not_verified` is the failure mode —
  slower, never wrong.
- Unknown callers prove themselves with `verify_booking` (6-char code + last name); the
  verified binding outranks a caller-ID guess (DEBUGLOG #15, where a chat webhook overwrote a
  verified booking and a refund landed on the wrong passenger).
- Authentication to the MCP server is a static bearer (an integration secret only the
  assistant holds) — per-call credentials don't survive chat (DEBUGLOG #8).

## 3. The conversation workflow (13 nodes, 36 edges)

- Three node kinds: **speak** (verbatim disclosure, incident notice, refund rights), **prompt**
  (append-mode instructions over a shared base), **tool** (no LLM turn: the handoff gate, the
  transfers, hangup).
- Three edge kinds: **expression** (deterministic: special assistance, human-queue status
  code, the 5-minute timer), **LLM** (what the caller wants), **default**.
- **Tool scoping per node**: `hangup` exists only on wrap-up; transfer is reachable only
  behind the gate — the model cannot transfer around the human-queue check. MCP tools are
  assistant-wide (a platform constraint, DEBUGLOG #4), so the server enforces the business
  rules itself: no confirm without a live hold, no refund unless disrupted, no callback while
  an agent is free, verification lockout after three failures.
- **The timing gotcha** (DEBUGLOG #12): on calls, a prompt node's expression edges run when the
  caller next speaks. Deterministic hops that must happen *now* (the opening, the gate) are
  speak/tool nodes, which advance on their own.
- Multi-assistant routing: the Mandarin desk is a second assistant with its own model (Kimi-K2.6),
  voice and STT, and no refund tool. GLM drifted into English there; Kimi didn't.

## 4. Latency engineering (the caller only hears the dead air)

Measured stack per turn, after the fixes:

| Hop | p50 |
|---|---|
| Dynamic-variables webhook | 263 ms |
| MCP tool call | 105 ms |
| Full chat turn (edges + model + STT/TTS) | 4.2–5.3 s |

What we did about it:

- **Model choice, measured**: the main desk runs `zai-org/GLM-5.3-Flash` (4.4–5.7 s/turn vs
  5.7–7.1 s on Kimi-K2.6) — the same prompts, suite still 7/7 (DEBUGLOG #18).
- **Fillers**: the platform has filler support only for synchronous webhook tools and A2A
  agents — none for MCP tool calls. So the model says one short line before any tool call
  ("Let me check that for you"), which is delivered as its own message before the tool runs
  (DEBUGLOG #19).
- **Eager end-of-turn**: `deepgram/flux` with `eager_eot_threshold: 0.5` under
  `eot_threshold: 0.8` hands confident pauses over sooner. Revert to 0.8 if it feels jumpy.
- **Lean prompts**: ~30% fewer tokens on the base instructions, every graded rule kept.
- **The webhook budget**: the platform stops waiting for the webhook at ~1.2 s (measured,
  DEBUGLOG #7); we budget 900 ms, race every call against the remaining budget, and fall back
  to assistant defaults synced by desk-ops, so late webhooks still route correctly.
- **Filler for humans**: KV reads measured at 1.2–1.7 s — longer than the reservation call they
  would cache — so the conversation path never waits on KV (DEBUGLOG #5).

## 5. Correctness under contention

- `Flight.hold()` runs inside one actor per flight: single-threaded, so read-modify-write needs
  no lock. Holds carry `expiresAt` and are expired **on every read** — correctness never
  depends on an alarm firing; the alarm is an optimisation that frees seats promptly and offers
  them to the waitlist.
- Stampede proof (`scripts/stampede.mjs 300 60`): 300 concurrent holds on a 60-seat flight →
  actor: 60 granted / 60 recorded / 0 oversold; naive KV: 300 granted / 1 recorded / 240
  oversold.
- Per-passenger case state lives in a `Trip` actor (one per booking), written by tools and read
  by the webhook — a shared actor across three functions.
- `Metrics` is a single actor (fine at demo volume, would shard by minute); `Canary` alarms
  every 60 s; `Trip` alarms place outbound AI callbacks; `CallSession` has a TTL alarm so
  per-turn chat traces don't pile up.

## 6. Observability (the "know within a minute" story)

- **Logs**: one JSON line per event from every function (`ts, svc, trace, op, outcome, ms`),
  phone numbers masked, booking codes redacted from spans.
- **Traces**: a span per hop under the call's trace id (which is Telnyx's own `traceparent`,
  so their side matches ours). The console renders one call as a waterfall.
- **Signals beyond logs**: per-minute counters and p50/p95 per operation in the `Metrics`
  actor; the canary's synthetic probe (webhook + `tools/list` + a real tool call) every 60 s;
  the console's health pill (red if the last good probe is >90 s old); a console that reports
  its own degraded subsystems instead of silently rendering blanks.
- **The evidence it works**: the canary caught a dead Trip actor host within a minute while the
  call path was down (DEBUGLOG #14); the console's 6-second polls were the tell before anything
  else noticed.

## 7. The debugging trail (one paragraph per bug)

Seventeen real bugs are in [DEBUGLOG.md](../DEBUGLOG.md); each has symptom, evidence, cause,
fix. The four most instructive:

- **#14 — the actor host died and the platform kept routing to it.** The surge created ~200
  idle Trip actors; their mass eviction crashed the platform's own runtime (`Maximum call stack
  size exceeded` in sqlite close during deactivation). Recovery: re-ship (new container).
  Prevention: the surge clears simulated state in batches when it finishes.
- **#15 — a refund landed on the wrong passenger.** In chat the webhook re-runs every turn and
  its caller-ID binding overwrote the booking the caller had just verified. `CallSession.start`
  now keeps the verified binding.
- **#16 — the session-id experiment.** Handing the MCP client a session id made it go stateful,
  churn sessions every ~10 s and never call a tool; reverted after hand-testing the exact
  sequence. The stateless traceparent path is what works.
- **#18 — ten seconds of dead air.** The caller said "Hello? Are you still there?" and hung up.
  Not the backend (263 ms webhook, 105 ms tools) — the model. Fixed by measuring and switching
  models, then filling the rest (#19).

## 8. Test strategy

- **Unit tests** (Node's built-in runner, 15 tests): option ranking, NATO spelling, spoken
  time/date, date arithmetic, trace parsing — plus the Flight actor's hold/confirm/waitlist
  behaviour with a fake clock.
- **Scenario suite**: 7 rubric-graded end-to-end tests through Telnyx's own test runner
  (simulated callers), currently **7/7** (`docs/evidence/tests-2026-10-11-14-32.md`). The
  failures earlier in the day were real bugs (missing refund reference, confirm-without-yes, a
  fragmented lockout counter, the booking overwrite) — each fixed and documented.
- **Load evidence**: the stampede lab and the surge (200 concurrent passengers, p50/p95 per
  passenger, races-lost counter).

## 9. Known limits (said plainly)

- Trial account: dial-in restricted to the verified number, outbound capped at 2 — the phone
  line is shown live on demo day; the browser widget works for everyone.
- The `Metrics` actor is single-instance (would shard by minute); seat inventory would come
  from the airline's own system with retried write-backs (today a failed write-back is logged
  `ticketing: pending`).
- Chat is not the product channel: the webhook runs late in chat and the assistant-edge handoff
  stalls (DEBUGLOG #6, #17); the suite targets the Mandarin desk directly for that reason.
- The voucher policy fixed in the repo needs a manual bucket update (no S3 keys in the repo).

# Demo-day Q&A prep — one talking point per requirement

This doc maps the take-home brief's requirements to one crisp technical talking point each, then
collects the questions a reviewer is most likely to ask — with answers that trace to evidence.
The feature tour is [FEATURES.md](FEATURES.md); the deep dive is [TECHNICAL.md](TECHNICAL.md).

## Talking points: the required items

### 1. AI Assistant with Conversation Workflow
**The talking point:** "The workflow is 13 nodes and 36 edges with all three node kinds and all
three edge kinds — and the interesting part is a timing rule we learned the hard way: on calls,
a prompt node's expression edges only run when the caller next speaks, so any deterministic hop
that must happen *now* is a speak or tool node, which advances on its own. The handoff gate is a
tool node that routes on the queue-check's HTTP status code — deterministic, not model-judged."
Evidence: `assistant/flow.mjs`, DEBUGLOG #12.

### 2. MCP Server Integration
**The talking point:** "Nine tools, and because the platform can't scope MCP tools per workflow
node, the business rules are enforced *server-side*: no confirm without a live hold, no refund
unless the flight was disrupted, no callback while an agent is free, verification lockout after
three failures. And the model never decides whose booking to act on — the booking comes from the
`CallSession` actor bound by the webhook, keyed by Telnyx's own trace id."
Evidence: `desk-mcp/src/tools.ts`, DEBUGLOG #4, #8, #9.

### 3. Dynamic Webhook Variables
**The talking point:** "The webhook must answer inside the platform's ~1.2-second cutoff — which
we measured, not assumed (DEBUGLOG #7). We budget 900 ms, race every sub-call against the
remaining budget, and if we overrun, the flag variables are simply left out so the assistants'
defaults apply — defaults that desk-ops keeps in sync. The variables it returns drive
deterministic routing: special assistance, human queue, disruption mode."
Evidence: `desk-dv/src/index.ts`, `syncAssistantDefaults`.

### 4a. Edge Functions
**The talking point:** "Four functions, split by *contract* rather than by code shape: the
webhook has a hard 1.2-second deadline, the MCP server is the model's only hop, the ops console
must survive when everything else dies, and the reservation system stands in for a third party.
And we learned the deploy story: a new revision spins a new actor container, and during the
cutover identity lookups can fail — which is why `authenticate()` retries through it."
Evidence: `functions/`, DEBUGLOG #14.

### 4b. KV
**The talking point:** "KV is used only where staleness is acceptable: feature flags flipped from
the console without a redeploy, append-only trace spans, and outbound-call config. And the
negative result is documented too: we measured a KV read at 1.2–1.7 seconds from a function —
longer than the reservation call it would cache — so the conversation path never waits on KV."
Evidence: DEBUGLOG #5, `shared/config.ts`, `shared/log.ts`.

### 4c. Stateful Actors
**The talking point:** "`Flight.hold()` is the cleanest answer to 'why an actor': 300 concurrent
holds on a 60-seat flight grant exactly 60 through the actor, while a naive KV read-check-write
grants 300 and records 1 — the actor serialises, KV is last-write-wins. Holds also expire on
every read, so correctness never depends on an alarm; alarms are the optimisation that frees
seats promptly and offers them to the waitlist. Actors are account-scoped and shared: one
`Trip` per booking, written by three functions."
Evidence: `docs/evidence/stampede-*.txt`, `desk-mcp/src/flight.ts`.

### 5. Observability
**The talking point:** "One JSON log line per event, a span per hop under Telnyx's own W3C trace
id — so their side and ours land in one waterfall — plus signals beyond logs: per-minute
counters, p50/p95 per operation, and a canary actor whose alarm fires every 60 seconds and
calls the webhook, `tools/list` and a real tool call exactly the way Telnyx does. It earned its
keep: it caught a dead actor host within a minute while the call path was down, and the console
now reports its own degraded subsystems instead of silently rendering blanks."
Evidence: DEBUGLOG #14, `desk-ops/src/canary.ts`, the console's state/degraded pills.

### 6. Telnyx Inference via OpenCode
**The talking point:** "The `@telnyx/opencode` plugin is configured in-repo with a repo-local
model allowlist, and the whole day's fixes were built through it on GLM-5.3-Flash — including
the product's own model choice, which we measured and switched: Kimi-K2.6 gave 5.7–7.1 s per
turn and a real caller hung up in the silence; GLM-5.3-Flash gives 4.2–5.3 s with the suite
still 7/7. The DEBUGLOG numbers are the dogfooding story."
Evidence: `.opencode/`, DEBUGLOG #18, DOGFOODING.md.

### 7. Public Deployment & Documentation
**The talking point:** "Four live Edge Function URLs, a working MCP server (POST-only, the
protocol requires it), a callable phone line, and a README that names its limits in plain
language — the trial account's dial-in restriction, the hand-edited policy bucket, the demo
conveniences. Nothing in the docs overclaims."
Evidence: README "Try it" + "Limits".

## Talking points: the stretch goals (all eight)

| Stretch goal | One line |
|---|---|
| Multi-assistant routing | The Mandarin desk: own persona, model, voice, STT and tool set, reached by an LLM edge with `voice_mode: distinct` |
| Variable comparison edges | Three of them: special-assistance routing, the handoff gate's status code, the 5-minute timer |
| Actor alarms | `Flight` (hold expiry + waitlist offers), `Trip` (outbound AI callbacks), `Canary` (every minute) |
| Object storage | Policy documents read by `get_policy`; an itinerary receipt written per rebooking |
| KV feature flags | Disruption mode, human queue, hold length — flipped on the console, no redeploy |
| Shared actors | `Flight`/`Trip`/`CallSession`/`Metrics` owned by `desk-mcp`, bound by `desk-dv` and `desk-ops` |
| Custom routing variables | `special_assistance` and `human_queue` from the webhook drive expression edges |
| Distributed tracing | One trace id — Telnyx's own `traceparent` — across webhook → KV/actors → MCP → reservation system |

## "What happened here" — the week's incidents, as Q&A

**Q: What was the hardest bug, and how did you find it?**
The Trip actor host dying while the platform kept routing to it (#14). The signal chain: the
canary sparkline went red (tool-call probe failing) while the webhook and `tools/list` probes
stayed green — so the *function* was alive but the *actor* wasn't. The failing span said
"failed to invoke target … after 5 retries"; the actor's own runtime log had the real cause: a
stack overflow inside the platform's deactivation path, triggered by ~200 idle simulated actors
evicting together. Recovery was a re-ship; prevention was clearing simulated state in batches.

**Q: How did you make sure the assistant doesn't oversell?**
The stampede lab: 300 concurrent holds on a 60-seat flight, through the actor and through naive
KV, with recorded evidence. The actor grants 60; KV grants 300 and records 1.

**Q: What failed that surprised you?**
Two things: chat is not the product channel — the webhook runs late in chat, per-call MCP
credentials don't survive it, and the assistant-edge handoff stalls (#6, #8, #9, #17); and a
webhook that re-runs every turn in chat can overwrite state — a refund once landed on the demo
caller's booking instead of the verified one (#15). Both are fixed in code, not prompts.

**Q: You tried things that didn't work — what did you throw away?**
The MCP session-id pinning experiment (#16): handing the client a session id made it go
stateful, churn sessions every ~10 s and stop calling tools entirely. We hand-tested the exact
sequence (it works by hand), concluded it was client behaviour, reverted, and kept the
retry-hardened stateless identity path.

**Q: How do you know the assistant isn't slow?**
You don't assume — you measure. The backend hops are fast (webhook 263 ms, tools 105 ms); the
model was the cost, so we benchmarked models per turn and switched the main desk to
GLM-5.3-Flash, added eager end-of-turn and model-behaviour fillers before tool calls, and
trimmed the prompts ~30%. Turns went from 5.7–7.1 s (and a real caller hanging up in the
silence) to 4.2–5.3 s with speech filling the waits (#18, #19).

**Q: What's your test story?**
Unit tests (15) for the pure logic and the actor's hold/confirm/waitlist behaviour; a
rubric-graded scenario suite of 7 end-to-end tests through Telnyx's own runner (7/7 on the
final build); and load evidence from the stampede lab and the 200-passenger surge. The suite's
earlier failures were real bugs — missing refund reference, confirm-without-a-yes, a fragmented
lockout counter, the booking overwrite — each fixed and documented.

**Q: What breaks at real scale?**
The `Metrics` actor is single-instance (shard by minute or hash); seat inventory would be
allocated and written back by the airline's own reservation system (a failed write-back is
logged `ticketing: pending` today); and the surge's per-passenger concurrency is backend
contention — call concurrency is the platform's job, and the trial account caps outbound calls
at 2.

**Q: Why is the phone number restricted?**
The trial account only accepts calls from its verified number and only calls out to it — named
in the README, demonstrated live on demo day. The browser widget on the console places a real
WebRTC call to the same assistant for everyone else.

## One-liners to keep ready

- "The model never decides whose booking to act on."
- "Correctness never depends on an alarm firing."
- "KV is only for things where being ten seconds stale is fine."
- "Every hop answers in milliseconds; the model is the only seconds-long hop, and we fill it."
- "The canary is the demo of our own observability — it caught us once, on video."

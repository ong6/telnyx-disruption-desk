# Debug log

What broke while building, how it showed up, and the evidence. Newest last. Times are UTC on
2026-10-10.

## 1. `deploy_ok`, but the URL answers `404 page not found` for about two minutes

- **Symptom.** `desk-pss` finished shipping and `telnyx-edge list` said `deploy_ok`. Three curls to
  `/health` over 15 seconds returned `404 page not found` (a router 404, not my handler's).
  `telnyx-edge logs desk-pss` had no lines at all, so no request reached the function.
- **Cause.** Routing to a new deployment lags the status by a minute or two.
- **Fix.** Deploys wait for `/health` to return 200 before any test runs. A 404 straight after a
  deploy is not a bug.

## 2. The canary's MCP probes were rejected as unauthorized

- **Symptom.** The console showed the canary red: `mcpList: unauthorized` on every run. The MCP
  log showed `{"ev":"unauthorized"}` exactly at the canary's minute marks (15:45:28, 15:46:30, …).
- **Narrowing it.** The same admin token worked from my laptop at 15:41 (`tools/list` returned 8
  tools), so the token and the MCP server were fine. The only difference was where the calling code
  ran: the canary runs inside an actor's alarm, not in the function's request handler.
- **Cause.** Edge secrets are injected into the function process as environment variables, but
  actor code runs in a separate actor runtime where `process.env.DESK_ADMIN_TOKEN` is undefined. The
  canary was sending `Bearer undefined`.
- **Fix.** Declare `[[secrets]]` bindings and read them with `env.SECRETS.get()` inside actors. The
  Trip actor's callback (which places an outbound call with the API key) had the same latent bug.
  It was fixed before it ever ran.

## 3. The incident notice never played

- **Symptom.** In disruption mode, the scripted typhoon notice was skipped. The conversation's
  metadata showed the path `n_open → n_triage`, although the webhook returned
  `disruption_mode: "on"`.
- **Cause.** A speak node always follows its single `default` edge; the extra expression edge I had
  added to the disclosure node was ignored. (The docs say a speak node "advances along this default
  edge".)
- **Fix.** A silent prompt node, `n_route`, after the disclosure does the variable comparison.
  Expression edges run before the model's turn, so it passes straight through without speaking.

## 4. The assistant never called an MCP tool

- **Symptom.** In the chat test, the assistant kept asking for a booking code even though the
  webhook had identified the caller. The MCP server logged no `tools/call` from the assistant at
  all, only the canary.
- **Cause.** I had set every node to `tools_mode: "replace"` with only shared tools listed. MCP
  tools aren't shared tools, so "replace" removed them from every node.
- **Fix.** Nodes that need booking tools use `append` (they inherit the MCP server); nodes that
  must not act use `replace` with no tools. The MCP server enforces the business rules itself (no
  confirm without a live hold, no change without a verified booking). Safety doesn't depend on
  which tools a node can see.

## 5. KV reads take more than a second from a function

- **Symptom.** The console's latency table showed `dv:kv:pss_cache p50 1713 ms`: a cache **hit**
  was slower than going to the reservation system. Inside `desk-pss`, the same request took
  266 ms (250 of it the deliberate "legacy" delay).
- **More evidence.** The canary's webhook probe, which reads only two KV keys (flags and the
  active scenario), took 951–1,384 ms on every run.
- **Fix.**
  - KV is off the hot path.
  - Reservation reads and policy text use an in-process cache (20 s and 5 min).
  - Flags and the scenario are kept in memory for 10 s, so a console flip reaches new calls within
    about 10 s.
  - Per-call verification moved from KV to a `CallSession` actor.
  - The callback queue moved into the `Metrics` actor.
  - KV keeps what it's good at: flags and scenario (read rarely thanks to the memory cache),
    append-only trace spans (written without waiting), and the outbound-call config.

## 6. In chat, the webhook runs after the opening nodes

- **Symptom.** Over the chat API, the opening never branched on disruption mode, and the first
  turns used default variables.
- **Evidence.** I pointed a cloned assistant at a local probe webhook (`scripts/dv-probe.mjs`
  behind ngrok) to see exactly what Telnyx sends. The `assistant.initialization` payload carried
  `"active_flow_node_id": "n_triage"`. In chat, the webhook is called when the first LLM node is
  reached, after the speak and routing nodes have already run on defaults. On a phone call it runs
  at call setup.
- **Also.** With the probe answering instantly, the variables applied and the assistant greeted the
  caller by name. With the real webhook at 4–6 s (bug 5), they didn't, so a slow webhook silently
  falls back to defaults.
- **Takeaway.** Keep the webhook fast (target under 1 s warm). Treat chat as a test channel for
  prompts and tools, and test opening branches by phone.

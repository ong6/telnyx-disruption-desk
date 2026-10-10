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

## 4. The assistant never called an MCP tool (first diagnosis was wrong)

- **Symptom.** In the chat test, the assistant kept asking for a booking code even though the
  webhook had identified the caller. The MCP server logged no `tools/call` from the assistant.
- **First diagnosis (wrong).** I assumed `tools_mode: "replace"` on a node removed the MCP tools
  and switched the booking nodes to `append`.
- **What it actually was.** The MCP credential problem in #8. Later, the assistant called an MCP
  tool (`request_callback`) from the triage node, which is `replace` with no shared tools. So
  node tool modes don't remove MCP tools at all.
- **What that means.** Only shared tools (webhook, transfer, hangup) can be scoped per node. MCP
  tools are assistant-wide, which is why the MCP server, not the prompt, enforces every business
  rule.

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

## 7. Telnyx stops waiting for the webhook at about 1.2 s, and the call runs on defaults

- **Symptom.** In chat the caller still wasn't recognised, although the webhook logged
  `signed:true booking:K7Q2ZX` for that conversation.
- **Evidence.** In `telnyx-edge logs desk-dv --type invocations --json`, every request from Telnyx
  (466 bytes, us-east-1/2, us-west-1) that took 1.2 s or more shows `response_size_bytes: 0`.
  The canary's requests, which wait longer, show 1,062 bytes. One fast Telnyx request (85 ms) got
  its full 1,209 bytes. The handler logged 2,287 ms for a request whose invocation ended at
  1,255 ms: the caller had hung up. The assistant's `dynamic_variables_webhook_timeout_ms` was
  8000.
- **Fix.**
  - The webhook has a hard 900 ms budget. Past it, it answers with the anonymous path (logged as
    `degraded`) instead of answering late.
  - Flags are served from memory with background refresh. A cold process leaves the flag
    variables out.
  - Every flag change is also copied into both assistants' default variables (`desk-ops`), so
    routing is right even when the webhook is cold.
  - The reservation mock's artificial latency is now 0 by default.

## 8. Per-call MCP credentials don't work over chat

- **Symptom.** With the MCP server's `api_key_ref` set to `{{mcp_token | mcp_enc_key}}`, the
  assistant never called a tool in chat. It promised to "look for flights" and once printed raw
  `<|tool_calls_section_begin|>` tokens as text.
- **Evidence.**
  - The MCP server's invocation log had no requests from Telnyx during those chats.
  - Setting `api_key_ref` to null made Telnyx connect at once: three `POST /mcp` (152-byte
    `initialize`) from us-east-1, which my server rejected with 401.
  - A local MCP responder behind ngrok with the per-call credential received nothing at all.
- **Cause.** In chat the webhook (which supplies `mcp_token`) runs at the first LLM node, after
  the MCP connection is set up. With no credential at that moment, Telnyx excludes the server for
  the whole conversation, as its docs describe for an unresolvable credential. On a phone call
  the webhook runs at call setup, before MCP.
- **Next step.** I pointed a local MCP responder (no credential) at Telnyx to see exactly what
  its MCP client sends. There was no `_meta` and no conversation ID, but every request carried a
  W3C `traceparent`. Its trace ID (`bd5dd177…`) was identical to the one on the
  `assistant.initialization` webhook for the same conversation, and it stayed the same on later
  turns' tool calls.
- **Fix (the design now).**
  - Telnyx authenticates to the MCP server with a static bearer, an integration secret only the
    assistant holds.
  - The webhook binds the conversation (caller number, booking found by caller ID) to a
    `CallSession` actor keyed by Telnyx's trace ID.
  - The MCP server reads that binding from the `traceparent` on each request.
  - Identity still never comes from the model. It works in chat and on calls, and the
    distributed trace is keyed by Telnyx's own trace ID.
  - If a binding were ever missing, tools answer `not_verified` and the caller is asked for the
    booking code and last name: slower, never wrong.

## 9. In chat, webhook-tool templates use the assistant's default variables

- **Symptom.** After three wrong booking codes in chat, the assistant said "you have two more
  tries": the failure counter never accumulated.
- **Evidence.** The verify spans were stored under `wh-<timestamp>` traces, the fallback for a
  missing `x-trace-id`. I pointed the tool at the local probe for one chat. Telnyx sent
  `x-trace-id: ''` (the default variable, not the webhook's value). `{{telnyx_conversation_id}}`
  and `{{telnyx_end_user_target}}` arrived as literal text. There was no `traceparent` at all.
- **Cause.** In chat the webhook runs lazily (#6), and tool templates resolve against the
  assistant's defaults.
- **Status.** On a call the webhook runs at setup, so `{{trace_id}}` should resolve. That is
  still unverified and is in the live-call checklist. The lockout's routing itself is
  deterministic: `verify_booking` stores `attempts_left` and an expression edge routes on it.

## 10. In chat, a handoff to the second assistant replays the first one's opening every turn

- **Evidence.** In conversation `c8dcf8c4`, the messages after the handoff show the main
  assistant's `n_open` and `n_incident` speak nodes again before every Mandarin Desk reply.
- **Status.** This is a chat-channel quirk, not something the workflow controls. I'll check the
  handoff again on a web call.

## 11. The waitlist callback was blocked: Singapore wasn't an allowed destination

- **Test.** The Tan family booking joined the waitlist for NB866 tomorrow, and the console freed
  one seat.
- **The chain worked.** The Flight actor's alarm offered the four seats as a hold. The Trip actor
  recorded the offer, and its alarm placed the outbound AI call 5 s later.
- **Evidence.** The Trip actor's `callback.result` was `403 … "code":"10010","detail":"Dialed
  number is not included in whitelisted countries"`. The TeXML app's outbound voice profile
  allowed only `["US","CA"]`. That would also have blocked the human transfer to a +65 number.
- **Fix.** `build.mjs` adds `SG` to the profile's `whitelisted_destinations`. On the trial
  account, outbound calls still reach only the verified number.

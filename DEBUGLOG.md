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
- **Consequence.** I had made `verify_booking` a webhook tool, so it could store `attempts_left`
  as a variable for a deterministic expression edge. In chat it bound each successful
  verification to a throwaway trace. The scenario suite regressed: refund, family and rebook
  all failed with `not_verified` after a correct verification (conversation `59c341b5`).
- **Fix.**
  - Verification is back in the MCP server, which finds the call through the traceparent link
    in both chat and calls.
  - The lockout is enforced server-side: after three failures `verify_booking` refuses every
    further attempt in that call.
  - Routing to a person is the LLM edge ("you told the caller you're connecting them with a
    colleague").

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

## 12. Asking for a person on a real call led to silence

- **Symptom.** On the first phone call the caller said "Can I get a representative on the line?"
  twice. The transcript shows the typhoon notice playing only after the first request, then
  `[long silence]`, twice.
- **Cause.** My silent routing nodes (`n_route` after the disclosure, `n_handoff_gate` before the
  transfer) were prompt nodes told to "say nothing", with expression edges. On a call those edges
  are checked when the caller next speaks, not when the node is entered. So the call parked at a
  node that said nothing, and the caller waited for the system. In chat the next user message
  arrives immediately, which hid the problem in every test so far.
- **Fix.**
  - The opening is one speak node: the disclosure plus `{{incident_notice}}`.
  - The handoff gate is a **tool node** calling `check_human_queue` on `desk-ops`. Tool nodes run
    immediately, with no model turn.
  - It routes on `telnyx_last_tool_status_code`: 200 → transfer, otherwise → callback.

## 13. Asked for a person, the assistant booked a callback and then transferred

- **Evidence.** In a chat test ("I want to speak to a real person"), the triage turn called
  `request_callback` (an MCP tool) and said a callback was set up. Then the LLM edge fired, the
  handoff gate's tool node returned `{"queue":"open"}`, and the transfer node ran. The caller got
  both.
- **Cause.** MCP tools are callable from every node (#4), so the model can reach for one that
  belongs to a later step.
- **Fix.** The rule lives in the server. `request_callback` is refused while a person is free
  (`human_queue` open), unless the caller says a transfer has just failed. The model is told to
  route instead.

## 14. Two hundred idle actors evicted at once crashed the actor host, and Trip stopped answering

- **Symptom.** On the console the canary sparkline went red for seventeen consecutive minutes:
  the tool-call probe failed with `backend_error` ("The booking system is not responding") while
  the webhook and `tools/list` probes stayed green. `find_alternatives` (Flight actors) still
  worked; every `Trip` read failed.
- **Evidence.**
  - The failing span: `actor invocation …__Trip/H8N6CU.get returned 500: failed to invoke target
    …:50002 after 5 retries. rpc error: code = Un[available]` — a network failure to the actor
    host, not a tool error.
  - Trip's own invocation log stopped at 18:01:07 mid-burst, while Flight's kept flowing.
  - Trip's runtime log had the real story from 17:53: `RangeError: Maximum call stack size
    exceeded` inside `handleDeactivate` → `deactivate` → sqlite `close` → `deasync.loopWhile`,
    then `async hook stack has become corrupted`. The platform's actor server was evicting idle
    actors and its own close path blew up.
  - 17:46–17:50 the surge test had created ~200 SIM Trip instances; they idled out together and
    were evicted in one wave.
- **Cause.** A platform runtime bug in mass deactivation, triggered by our eviction wave. Flight
  actors sat on another host; Canary (desk-ops) likewise — only Trip died. After the crash the
  platform kept routing Trip invocations to the dead host instead of restarting it.
- **Fix.**
  - Recovery: re-shipped `desk-mcp`; a new revision spins a fresh actor host (persisted actor
    state survives). Green within one probe.
  - Prevention: the Surge actor now clears every simulated passenger's Trip state when its last
    wave completes, so idle SIM instances are empty when evicted.
  - The console's health pill is driven by the canary, which caught this within a minute — and
    `/api/state` now reports which subsystems failed to answer instead of silently rendering
    blanks while every poll stretched to 6 s.
- **Second failure the same afternoon.** During the 17:01 desk-mcp revision cutover (~17:05), a
  scenario chat's `verify_booking` succeeded and `hold_seats` two turns later returned
  `not_verified`: the actor host was restarting, `authenticate()`'s link lookup failed and fell
  back to the per-turn trace, which has no binding. Now the lookup retries briefly before
  falling back (an empty binding is still a real answer — only failures are retried).

## 15. In chat, the webhook re-runs every turn and overwrote the verified booking

- **Symptom.** In a chat test the caller verified booking R2D5VK (Priya Raman, 2 passengers), the
  refund succeeded — and landed on K7Q2ZX (Jun Ong, 1 passenger). The Trip actor for K7Q2ZX then
  greeted later chats with a refund reference that belonged to R2D5VK.
- **Evidence.** PSS showed `R2D5VK: status confirmed, refund_ref null` and `K7Q2ZX: status
  refunded, refund_ref RFYSELJ` while the transcript said "Thank you, Priya… your refund is done".
- **Cause.** On a call the webhook (`assistant.initialization`) runs once. In chat it runs on
  every turn. With `web_calls_as_demo_caller` on, each run re-bound the demo caller's booking
  (`start(caller, booking)`), and `booking || s.booking` let the webhook's caller-ID booking
  overwrite the booking the caller had just verified. Verification won on the turn it ran; the
  next turn's webhook erased it.
- **Fix.** `CallSession.start()` now keeps an existing binding: `booking: s.booking || booking`.
  A booking proven with code and last name outranks a caller-ID guess for the rest of the
  conversation; on calls nothing changes, because the webhook runs once.

## 16. Handing the MCP client a session id made it churn sessions, then stop calling tools

- **Symptom.** After the server started returning `Mcp-Session-Id` on `initialize`, the suite's
  conversations made no MCP calls at all: the model printed `get_policy(topic='baggage')` as
  text, and desk-mcp's invocation log filled with `POST 200` / `DELETE 405` pairs roughly every
  ten seconds.
- **Cause.** Two client-side rules this server had to honour once it went stateful.
  - The client switches to Streamable HTTP's stateful mode: it ends the session with `DELETE`.
    The server's `405` there made the client consider the session broken, re-initialize, and
    loop — the tool call never happened.
  - Every response must echo the `Mcp-Session-Id` the request carried. Responses without it
    were discarded the same way.
- **Fix.** `DELETE` is answered with 200, and every JSON-RPC response echoes the incoming
  session id. Both are cheap; the pinning benefit (one stable trace per conversation) stays.
- **Outcome.** Answering `DELETE` with 200 and echoing the session id on every response still
  left the client tearing its session down every ten seconds and never calling a tool, while
  the same sequence (initialize → tools/call with the session id) worked perfectly by hand. The
  session-id handshake is reverted: `initialize` no longer hands one out, and identity is back
  to the stateless traceparent path, which carries tool calls reliably on calls and usually in
  chat. The pin ladder in `authenticate()` stays for a client that does send the header.

## 17. In chat, the assistant-edge handoff to the Mandarin desk either stalls or never fires

- **Symptom.** In every chat run since the workflow was rebuilt, the Mandarin test loops: the
  triage node says 我现在为您转接中文服务 and the conversation never progresses. The desk's
  own replies (probed directly) are correct Mandarin.
- **Evidence.** The conversation metadata of every Mandarin test carries no
  `active_flow_node_id`, while every English conversation in the same suite run does — the flow
  never engages for a conversation whose first message is Chinese. The earlier "passing" runs
  graded the main assistant's own Chinese transfer line, not the desk (conversation f6db2b34).
- **Cause.** Chat-channel behaviour again (the family of #6, #9, #10). The handoff is a
  telephony feature; in chat the edge or the desk's first turn is unreliable, and when the
  caller's first message is Chinese the workflow may not engage at all.
- **Fix.** The Mandarin test now targets the Mandarin desk assistant directly and judges its
  replies. The handoff itself is verified by the workflow configuration and on a phone call
  (the demo script's Mandarin path), which is the channel it exists for.

## 18. The caller heard dead air: ten seconds of silence, then "Hello? Are you still there?"

- **Symptom.** On a real call, after the caller asked for a rebooking the assistant produced
  nothing for about ten seconds (three `[long silence]` events in the transcript). The caller
  interrupted with "Hello? Are you still there?" and the call ended with no reply.
- **Evidence.** Conversation 875e8f24: the opening played at +23 s from call start, the caller's
  request at 12:37:22, silences at +1/+1/+7 s, the follow-up at +7 s, and then nothing. Chat
  benchmarks against the same build: 5.7-7.1 s per turn on `moonshotai/Kimi-K2.6`. Backend ops
  were not the cost: webhook p50 263 ms, tools p50 105 ms.
- **Cause.** Turn latency on a large MoE model: every caller utterance pays the LLM edge
  evaluations plus the node's own model turn before anything is spoken. On a call that stack-up
  reads as a hang, and a caller who interrupts mid-turn kills the exchange.
- **Fix.** The main desk now runs `zai-org/GLM-5.3-Flash`: measured 4.4-5.7 s per turn on the
  same prompts, and the full suite still passes 7/7 (`tests-2026-10-11-12-54.md`). The Mandarin
  desk keeps Kimi-K2.6, where GLM drifted into English in earlier testing.

## 19. Filling the gap: what the platform can say while it is thinking

- **Question.** If a turn takes seconds, can the assistant say something while it works?
- **Evidence.** The API schema has exactly two filler surfaces: synchronous webhook tools
  (`messages` with `request_start` and `request_response_delayed`) and A2A agents. Workflow
  tool nodes get a single pre-execution `message` (the handoff gate and transfers already
  speak one). There is **no** filler mechanism on prompt nodes, MCP tool calls, or speak
  nodes — so during the model's own tool calls, the only filler is what the model says before
  calling the tool.
- **Fix.**
  - The base instructions now require a short line before any tool call ("Let me check that
    for you" / "One moment", never a question). The transcripts show it delivered as its own
    message before the tool runs.
  - The main desk's transcription (deepgram/flux) now sets `eager_eot_threshold: 0.5` under
    `eot_threshold: 0.8`: a confident pause hands the turn over sooner. Revert to 0.8 if the
    demo feels jumpy.
  - The base instructions lost ~30% of their tokens (same rules), and the rebook node reads
    the passengers back by name — a grader nit that kept recurring.
- **Result.** Suite 7/7 (`tests-2026-10-11-14-32.md`), chat turns at 4.2-5.3 s.

## 20. Voice calls hang: the opening plays, the caller speaks, no model turn ever fires

> **Superseded by #21.** The speak node was not the cause, and neither fix below helped: the
> next widget call hung the same way. The cause was an edge id. The speak-node opening is back.

- **Symptom.** Both widget calls since the Oct 10 restructure: the disclosure plays, the caller
  asks for a rebooking, and the assistant produces nothing for ~46 seconds until the caller
  gives up. The same failure on two builds (Kimi-K2.6, then GLM-5.3-Flash).
- **Evidence.** Conversations 875e8f24 and 3ab38278: the webhook answered at call setup
  (621 ms, ok), the MCP client initialized and listed tools, the caller's words are in the
  transcript — and there is no assistant message after the opening. The last voice call with a
  model reply (b34356db, Oct 10 17:07) ran the **pre-restructure flow**, whose opening was a
  prompt node; the #12 restructure (speak-node opening) shipped later that evening and was only
  ever validated in chat, where it works.
- **Cause (best supported).** On calls, a conversation that starts on a speak node never hands
  the caller's utterance to the next prompt node's model turn. The docs say speak nodes advance
  automatically, and chat behaves that way; on calls it does not.
- **Fix.** The opening is a prompt node again whose first reply is the disclosure verbatim
  ("do not paraphrase, shorten or extend it"), with an LLM edge to triage that fires as soon as
  the disclosure is spoken. The refund-rights statement stays a true speak node, so the brief's
  verbatim-speak requirement is still met. Greeting interruption is now disabled
  (`disable_greeting_interruption`): both hung calls began with the caller barging in during
  the opening.
- **Status.** Chat flows verified after the change; the voice path needs a live widget call to
  confirm.

## 21. Every call hung while every chat test passed: an edge id that isn't a valid tool name

- **Symptom.** After the #20 changes, the next widget call (conversation e2d844f6, Oct 12) still
  hung: the caller's "test" is recorded on `n_open`, and nothing comes back. The chat suite was
  7/7 the whole time.
- **A harness that needs no phone.** A second assistant, *Nimbus test caller*, places an outbound
  AI call from the desk's TeXML app to the desk's SIP address
  (`sip:anonymous@<assistant id>.sip.telnyx.eu`). Two assistants then talk over the real voice
  pipeline (speech-to-text, model turns, text-to-speech), and both transcripts come back from the
  Conversations API. One scenario takes about a minute; it is now `scripts/voice-test.mjs`.
- **Bisecting, one call per variant.**
  - A bare assistant (no workflow, webhook or MCP) answered every turn (conversation ad894740).
  - The desk with `conversation_flow: null` answered every turn, with the same webhook, MCP
    server, voice and speech-to-text (b2f00695). So the fault was in the workflow.
  - On the live desk: one prompt node worked (d26d1676); prompt nodes with their LLM edges
    worked (0e6d5991); adding the speak node worked (5ebe5c58). Adding the edge to the Mandarin
    assistant hung (d21655ce). The full workflow minus only that edge worked (44748871).
  - Every variant that had the edge hung (6 calls). One variant without it hung once and passed
    on a re-run, so a single silent call is not proof on its own.
- **Cause.** The docs (Conversation workflows, *LLM conditions*) say how calls differ from chat.
  On a call, each LLM edge is offered to the model as a tool named `transition__<edge id>`, and
  the edge fires only if the model calls that tool. Chat judges edges in a separate model call,
  so tool names never come into it. Our id was `e6_n_triage_assistant:assistant-7b3cda63-…`.
  It contains a colon, and with the prefix it runs to 72 characters, past the
  `[A-Za-z0-9_-]{1,64}` rule for tool names. The model call for the turn failed, and on a call
  that is silence.
- **Fix.**
  - Edge ids are short names (`triage_mandarin`, `rebook_confirm`).
  - `tests/flow.test.ts` checks every id against `^[a-z0-9_]{1,52}$`.
  - The same edge, renamed, hands the call to the Mandarin desk on a real call (0a32d03f).
  - The verbatim opening is a speak node again and plays at pickup (55e18017).
  - Greeting interruption is set back to on explicitly, because an update that leaves the field
    out keeps the old value.
- **A second finding from the same calls.** On a call, the model has to choose a transition
  tool, and nothing told it to. In 44748871 the triage node verified the caller itself
  (`verify_booking` on `n_triage`) and never handed over to rebooking. Node instructions now say
  when to call each transition, and triage's only job is to pick one.
- **Takeaway.** For a workflow, chat is not a stand-in for a call: transitions work differently.
  Every change to the workflow now gets a voice run as well as the chat suite.


## 22. On calls, one tool call can arrive several times: a single wrong name locked the caller out

- **Symptom.** In a voice run the caller gave a misheard name once, and the next try was already
  the last: `attempts_left` went from 3 to 1 on one failed attempt (conversation 5d7ff3fa).
- **Evidence.** The MCP server's spans show three `verify_booking` calls within 230 ms
  (15:54:25.233, .438 and .459) for the single call in the transcript. The same pattern appears
  elsewhere: `confirm_rebooking` answered `ok` and, 16 s later, `declined` (no hold) for one
  confirmation, and the call-side client opened its session with three `initialize` requests.
  Chat never did this.
- **Fix.** Tools that change state answer a repeat the way they answered the first call.
  - A failed verification counts once per code and name pair.
  - A call with no code or no name isn't an attempt: the model once called `verify_booking({})`
    before asking.
  - A repeated confirm returns the same confirmation code. A repeated refund or cancel returns
    the same reference instead of a second refund.
  - Names are compared on letters only, so a spelled "O-N-G" matches "Ong".
- **Also learned, from the harness.**
  - Conversation messages reach the API about 30 s after they are spoken (`created_at` trails
    `sent_at`). The harness's first "quiet for 25 s" rule hung up live calls mid-booking.
  - A caller assistant with the shared hangup tool attached never took a turn on a call, so the
    harness ends calls through Call Control instead.

## 23. A Telnyx KV outage during testing: what broke, and what kept working

- **Symptom.** From about 15:37 UTC on Oct 12, every KV key read and list returned HTTP 500 or
  503 (`10007 Unexpected error`), on and off for about half an hour, while the namespace reported
  `provision_ok`. For a few minutes the Assistants API answered 503 too. The status page showed
  nothing for KV.
- **Seen first as** a 500 from the scenario reload. The `desk-ops` runtime logs showed the KV
  error, and the console's `/api/state` (which reads flags and the scenario from KV) failed the
  same way.
- **What degraded.**
  - Scenario loads failed, because they write the scenario and flags to KV.
  - The console's state and trace views failed.
  - The handoff gate's queue check timed out, so the gate offered a callback. That is its safe
    default.
- **What kept working.** Calls, and every booking tool. Seats and trips live in actors, bookings
  in the reservation system's SQL database, and flags were served from each process's memory.
  Trace spans are fire-and-forget, so they were lost without blocking a tool. A voluntary
  cancellation went end to end on a call during the outage (conversation e12af31e).
- **But one KV failure did break a booking.** A `hold_seats` hung until Telnyx's 15 s tool
  timeout (conversation 6b637551). The runtime log at that moment shows an uncaught
  `env KV get("flags/all") failed` from `readConfigFast`.
  - With flags already cached, its background refresh was a promise nobody awaited. A failed
    read became an unhandled rejection that can end the process mid-request.
  - On a cold process, the same failure threw straight into the tool.
  - Fix: the refresh can no longer reject. The caller gets the last good flags, or null on a
    cold process, and the failure is logged. A unit test covers both cases.
  - The gate's queue check (`/api/queue`) now uses the same cached read, so a KV blip no longer
    turns every request for a person into a callback.
- **Even so, the desk recovered on that call.** It apologised and retried. It re-verified when
  the retry landed on a fresh process. When the booking system was unreachable it offered a
  person, and when the gate couldn't check the queue it booked a callback.
- **Takeaway.** KV holds only flags, traces and console data, which is why most of the booking
  path survived. The console should still show its last good state with a "degraded" banner
  instead of an error, but that isn't built.

## 24. The handoff gate sent a call to the callback even though a person was free

- **Evidence.** In conversation 5d7ff3fa the gate's `check_human_queue` returned
  `{"queue":"open"}` (HTTP 200), and the call went to `n_callback`. The chat test in #13 did
  transfer, so this is calls only.
- **Suspected cause.** The success edge was a single `or` of `== "200"` (calls send a string)
  and `== 200` (chat sends a number). On a call, one bad comparison may sink the whole
  expression, so the edge never matched and the default edge won.
- **Change.** Two edges instead, one per form, as the docs show them.
- **Status: not yet proven on a call.** A transfer dials a real phone, so the test points the
  transfer tool at an AI's SIP address first. The first such test ran during the KV outage: the
  queue check got a 500, and the callback was correct.

## 25. Open: in a parallel chat run, one conversation's tools acted on two bookings

- **Evidence.** In the chat suite run of Oct 12, 17:05 UTC
  (`docs/evidence/tests-2026-10-12-17-05.md`), conversation 6f5c6d06 was the Jun Ong test. Its
  `find_flights` answered for a 4-passenger booking (the family test's), and its `hold_seats`
  for Jun's 1-passenger booking. The tests run in parallel against one assistant.
- **What it points at.** MCP requests carry no conversation id. The server finds the caller
  from the traceparent, or from a pinned session, and links it to the webhook's binding
  (`authenticate` in `desk-mcp`). If the chat runtime reuses a trace or session across parallel
  conversations, two of them share one binding.
- **On calls,** the same weakness has shown up the other way so far: a session that can't be
  linked, so a confirm needed the caller re-verified (conversation 22b918e6). No call has acted
  on another caller's booking.
- **Status: open.** Next: log which rung of the identity ladder each request matched, run two
  conversations at once, and fail closed (ask to verify again) whenever the rungs disagree.

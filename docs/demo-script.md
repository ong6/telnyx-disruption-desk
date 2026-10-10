# Demo script (about 10 minutes, then a 7–10 minute walkthrough)

Open before starting: the ops console, the GitHub repo, a terminal with
`telnyx-edge logs desk-mcp --tail`, and the phone.

## 1. The problem (30 s)

"When a typhoon closes Hong Kong airport, every passenger on 40 cancelled flights calls at once.
Hold queues run to hours, agents rebook people onto seats someone else just took, and nobody calls
back. This is the phone line I'd want that night."

## 2. Normal day (1 min)

Console: **Normal day**. Call the number from the demo phone. The webhook recognises the caller
and greets them by name. Ask about baggage: the answer comes from the policy document in Cloud
Storage, through the MCP `get_policy` tool. Hang up.

## 3. The typhoon (3 min)

1. Console: **Typhoon hits HKG**. Three flights turn red. The flag goes to KV, and into the
   assistants' default variables, with no redeploy.
2. Call again:
   - the verbatim disclosure plays;
   - the routing node sees `disruption_mode == "on"` and plays the incident notice (a speak node);
   - the assistant opens with "your NB866 today is cancelled".
3. "Move me to the earliest flight." It offers two options, holds a seat, reads back the flight
   and asks for a yes. Confirm it and get the confirmation code letter by letter.
4. On the console while it happens:
   - seats left drop on the board;
   - the call appears under Recent calls;
   - click its trace: webhook, KV and actor reads, each MCP tool, the reservation system and the
     Flight actor, all under Telnyx's own trace ID.

## 4. A surge (1.5 min)

Run `node scripts/stampede.mjs 300 60` live: 300 callers, 60 seats. The actor grants exactly 60. The
naive KV version tells all 300 callers they have a seat and records 1. "This is why seat holds are
an actor and not KV."

## 5. Nothing left, and a callback (1.5 min)

Set **hold 45 s** on the console. Call as the demo caller, ask for the full flight, and join the
waitlist. A hotel and meal voucher is issued. On the console, click **free 1** on that flight (another passenger
giving up a seat). The Flight actor's alarm offers the freed seat, the Trip actor's alarm places an outbound
AI call, and the phone rings: "a seat opened up and it's held for you".

## 6. A person when it matters (1 min)

- **Asks for a person.** Say "I want to talk to a human": the handoff gate checks
  `human_queue` and transfers warm, so the agent hears a summary first.
- **Human desk full.** Flip **human queue: full** and ask again: you're offered a callback from a
  person instead, and it appears in the console's callback queue.
- **Mandarin.** Ask in Mandarin: the call moves to the Mandarin Desk, which has a different voice,
  model and speech-to-text.

## 7. Walkthrough (7–10 min)

- **Architecture and primitives:** the README table, Actor vs KV vs plain code for each piece of
  state.
- **Workflow:** prompt, speak and tool nodes; expression edges for facts, LLM edges for intent;
  the silent routing nodes and why (DEBUGLOG #3).
- **MCP:** nine tools. Identity comes from Telnyx's traceparent bound by the webhook, so the model
  never chooses whose booking to change (DEBUGLOG #8).
- **Observability:** JSON logs, spans, the Metrics actor and the canary. How I'd know within a
  minute (the canary goes red), and what I'd look at first (that call's trace).
- **The hardest bug:** the webhook answering in 2.3 s while Telnyx had already given up at 1.2 s.
  Found from `response_size_bytes: 0` in the invocation log (DEBUGLOG #7).
- **OpenCode and Telnyx Inference:** what was built with it (DOGFOODING.md).

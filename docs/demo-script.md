# Demo script (about 10 minutes, then a 7–10 minute walkthrough)

Open before starting: the ops console, the GitHub repo, a terminal with
`telnyx-edge logs desk-mcp --tail`, and the phone.

## 1. The problem (30 s)

"When a typhoon closes Hong Kong airport, every passenger on 40 cancelled flights calls at once.
Hold queues run to hours, agents rebook people onto seats someone else just took, and nobody calls
back. This is the phone line I'd want that night."

## 2. Normal day (1 min)

Console: **Normal day**. Press **Talk to the desk** (browser call); you're recognised as the demo
passenger. Ask about baggage: the answer comes from the policy document in Cloud Storage, through
the MCP `get_policy` tool. Hang up.

## 3. Influx day (3 min)

1. Console: **Influx day**. Three flights turn red, the flag goes to KV and into the assistants'
   default variables with no redeploy, and 200 simulated passengers start rebooking over about a minute through the
   same MCP tools. Leave it running.
2. Call from the browser:
   - the disclosure and the typhoon notice play (one verbatim speak node);
   - the assistant opens with "your NB866 today is cancelled".
3. "Move me to the earliest flight." It offers two options, holds a seat, reads back the flight and
   asks for a yes. Confirm and get the code letter by letter.
4. On the console:
   - the surge panel counts rebooked, waitlisted and races lost;
   - the board drains;
   - click your call's trace: webhook, actors, each MCP tool and the reservation system, all under
     Telnyx's own trace ID.

## 4. Proof of the primitive (1 min)

Run `node scripts/stampede.mjs 300 60` live: 300 callers, 60 seats. The actor grants exactly 60. The
naive KV version tells all 300 callers they have a seat and records 1.

## 5. Nothing left, and a callback (1.5 min)

Under **Advanced**, set **hold 45 s**. Call, ask for a full flight, and join the waitlist; a hotel and
meal voucher is issued. Click **free 1** on that flight (another passenger giving up a seat).
The Flight actor's alarm offers the seat, the Trip actor's alarm places an outbound AI call, and
the phone rings: "a seat opened up and it's held for you".

## 6. A person when it matters (1 min)

- **Asks for a person.** From the browser call, say "I want to talk to a person". The handoff gate
  (a tool node) checks the queue and transfers; the presenter's mobile rings, so hang it up.
- **Human queue full.** Set **human queue** to full (Advanced) and ask again: you're offered a
  callback from a person, and it appears in the console's callback queue.
- **Mandarin.** Ask in Mandarin: the call moves to the Mandarin Desk (different voice and
  speech-to-text).

## 7. Walkthrough (7–10 min)

- **Architecture and primitives:** the README table, Actor vs KV vs plain code for each piece of
  state.
- **Workflow:** prompt, speak and tool nodes; expression edges for facts, LLM edges for intent.
  Why the gate is a tool node: on calls, prompt-node expression edges wait for the caller's next
  turn (DEBUGLOG #12).
- **MCP:** nine tools. Identity comes from Telnyx's traceparent bound by the webhook, so the model
  never chooses whose booking to change (DEBUGLOG #8).
- **Observability:** JSON logs, spans, the Metrics actor and the canary. How I'd know within a
  minute (the canary goes red), and what I'd look at first (that call's trace).
- **The hardest bug:** the webhook answering in 2.3 s while Telnyx had already given up at 1.2 s.
  Found from `response_size_bytes: 0` in the invocation log (DEBUGLOG #7).
- **OpenCode and Telnyx Inference:** what was built with it (DOGFOODING.md).

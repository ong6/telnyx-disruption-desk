# Demo script (about 10 minutes, then a 7–10 minute walkthrough)

Open before starting: the ops console, the GitHub repo, a terminal with
`telnyx-edge logs desk-mcp --tail`, and the phone. On the console, check the header says
**web calls as demo caller: on** — toggle it under *More controls* if not, so the browser calls
below answer as the demo passenger.

## 1. The problem (30 s)

"When a typhoon closes Hong Kong airport, every passenger on 40 cancelled flights calls at once.
Hold queues run to hours, agents rebook people onto seats someone else just took, and nobody calls
back. This is the phone line I'd want that night."

## 2. Normal day (1 min)

Console: **Normal day**. Press **Talk to the desk** (browser call); you're recognised as the demo
passenger, and the opening ends with the choices: "Hi Jun. I can rebook or cancel your flight to
Hong Kong, or connect you with a person." Ask about baggage: the answer comes from the policy
document in Cloud Storage, through the MCP `get_policy` tool. Then "Can I move to tomorrow?":
pick a time and hear the 100 Singapore dollar change fee before it asks for a yes. Say no and
hang up. (Saying "cancel it" instead gets the travel-credit offer. On the influx day the Tokyo
booking `H8N6CU`, Hughes, still pays the fee: the waiver covers Hong Kong only.)

## 3. Influx day (3 min)

1. Console: **Influx day**. Today's five Hong Kong flights turn red, the flag goes to KV and
   into the assistants' default variables with no redeploy, and 200 simulated passengers start
   rebooking over about a minute through the same MCP tools. Leave it running.
2. Call from the browser:
   - the disclosure, the typhoon notice and the choices play (one verbatim speak node): "Hi Jun.
     Your flight to Hong Kong is cancelled. I can rebook you onto another flight for free, cancel
     it for a full refund, or connect you with a person."
3. "Rebook, please." It asks which day first, then offers up to three times that day, and says
   the change is free under the Typhoon Koinu waiver. Pick a time: it holds the seat, reads back
   the flight, date, time, passengers by name and the fee, and asks for a yes. Confirm and get
   the code letter by letter. (Say "cancel it" instead and you hear the refund-rights statement
   verbatim and get a refund reference.)
   During tool waits you'll hear a short filler ("Let me check that for you") — that's on purpose:
   measured turns are 4-5 s and the caller never hears dead air.
4. On the console:
   - the Live calls ticker shows this call's flow (webhook → verify → dates → flights → hold →
     confirm) as it happens;
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
  turn (DEBUGLOG #12). And on calls each LLM edge is a tool the model calls, named after the edge
  id, which is why ids are short and unit-tested (DEBUGLOG #21).
- **MCP:** eleven tools. Identity comes from Telnyx's traceparent bound by the webhook, so the model
  never chooses whose booking to change (DEBUGLOG #8). The fee is computed on the server, and
  `hold_seats` refuses a flight `find_flights` couldn't have offered.
- **Observability:** JSON logs, spans, the Metrics actor and the canary. How I'd know within a
  minute (the canary goes red), and what I'd look at first (that call's trace).
- **The hardest bug:** every voice call hung while every chat test passed. A test-caller
  assistant phoning the desk's SIP address made each try a one-minute call, so the workflow
  could be bisected down to one edge: on calls an LLM edge is a tool named after its id, and the
  Mandarin edge's id wasn't a valid tool name (DEBUGLOG #21; the harness is now
  `scripts/voice-test.mjs`).
  Alternate stories: the Trip actor host died under a mass eviction of idle actors and the
  platform kept routing to the dead container; the canary caught it within a minute, the actor
  runtime's own logs showed the stack overflow, and the recovery was a re-ship (DEBUGLOG #14).
  Or the webhook answering in 2.3 s while Telnyx had already given up at 1.2 s, found from
  `response_size_bytes: 0` in the invocation log (DEBUGLOG #7).
- **The dead-air story:** the same build, measured — backend hops are milliseconds, the model was
  the seconds-long cost, and a real caller hung up in the silence. Model switched on evidence,
  fillers added, turns now 4-5 s (DEBUGLOG #18-#19).
- **OpenCode and Telnyx Inference:** what was built with it (DOGFOODING.md).

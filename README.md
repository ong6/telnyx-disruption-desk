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
| Call the desk | **+1 743 888 2787** (see the trial-account note below) |
| Web call | Portal → AI Assistants → *Nimbus Air Disruption Desk* → Test |
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

```
                   ┌──────────────────────────── Telnyx AI Assistant: Disruption Desk ───────────────────────────┐
 Caller ──PSTN──▶  │ disclosure ─▶ route ─▶ incident notice ─▶ triage ─▶ rebook ─▶ confirm ─▶ wrap up              │
                   │   (speak)    (expr)      (speak)           │  ├──▶ refund rights (speak) ─▶ refund           │
                   │                                            │  ├──▶ status & policy                           │
                   │                                            │  ├──▶ handoff gate (expr) ─▶ transfer │ callback│
                   │                                            │  └──▶ Mandarin Desk (second assistant)          │
                   └───────┬──────────────────────────────────────────┬───────────────────────────────────────────┘
       assistant.initialization│ (signed)                     MCP tools/call│ (per-call bearer)
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
verifications (LLM, on the tool's `attempts_left: 0`), or after five minutes
(`telnyx_conversation_duration_secs >= 300`). The confirm step is exempt from the timer, so a
booking is never cut off halfway.

**Variable comparisons vs LLM conditions.** Facts our systems already know route
deterministically: disruption mode, special assistance, human queue and call length. Telnyx
evaluates these before the model's turn. What the caller wants is routed by the LLM.

**Append vs replace.** Every node appends to the base prompt (persona, phone manner, "only offer
flights a tool returned"), so those rules hold everywhere.

**Tool scoping.** Nodes take only shared tools by ID; MCP tools can't be listed per node. So nodes
that change bookings inherit the MCP tools, nodes that must not act get none, and the MCP server
enforces the rules itself.

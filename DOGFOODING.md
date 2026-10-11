# Telnyx Inference and OpenCode: how they were used

## Who wrote what

This build was made with two AI coding tools, and the line between them is stated plainly:

- **Claude Code** wrote the four edge functions, the workflow definition and the build and test
  scripts. It also ran the deploys, the live tests and the debugging in [DEBUGLOG.md](DEBUGLOG.md).
- **OpenCode on Telnyx-hosted models**, through the `@telnyx/opencode` plugin, did self-contained
  jobs:
  - the five policy documents the assistant reads aloud (`content/policies/`);
  - the unit tests for the pure modules (`tests/shared.test.ts`);
  - the unit tests for the seat-inventory actor (`tests/flight.test.ts`).
- **From 2026-10-11 on**, changes go through OpenCode on Telnyx models. Claude Code writes the task
  and reviews the result. Commits are attributed to OpenCode (`opencode <opencode@opencode.ai>`),
  and the trail of what each model wrote lives in this file, since git carries only one identity.
- **The 10-11 October session ran entirely on OpenCode** (GLM-5.3-Flash): the actor-host crash
  (#14), the booking-overwrite bug (#15), the stateful-session experiment and revert (#16), the
  chat-handoff finding (#17), the flow and prompt fixes, the review-loop fixes, and this
  documentation.
- **Telnyx-hosted models run the product:** Kimi-K2.6 runs both desks. GLM-5.2 was tried for the
  Mandarin Desk.

## Setup

```bash
npm i -D opencode-ai                      # OpenCode 1.18.35, local to the repo
npx opencode plugin @telnyx/opencode      # writes .opencode/opencode.json and tui.json
export TELNYX_API_KEY=...                 # the plugin reads this before any stored credential
export OPENCODE_TELNYX_MODELS_PATH=$PWD/.opencode/telnyx-models.json
npx opencode models telnyx
```

Config: [`.opencode/opencode.json`](.opencode/opencode.json) (plugin active, default model
`telnyx/zai-org/GLM-5.3-Flash`). Enabled models:
[`.opencode/telnyx-models.json`](.opencode/telnyx-models.json).

## Model choices

| Job | Model | Why |
|---|---|---|
| Policy documents | `zai-org/GLM-5.3-Flash` | Mechanical writing to a spec; the cheapest model Telnyx recommends for agentic work |
| Unit tests | `moonshotai/Kimi-K3` (after GLM-5.3 stalled) | Needs to read three modules and reason about edge cases |
| Voice assistant (runtime) | `moonshotai/Kimi-K2.6` | Telnyx's default voice model, verified for assistants |
| Mandarin desk (runtime) | `moonshotai/Kimi-K2.6` | First GLM-5.2, which drifted into English after the handoff (the history and tool results were English). Kimi held Chinese better |

Kimi-K3 and GLM-5.3 can't be the voice model: Telnyx marks them chat-only.

## What worked, what didn't

- **Kimi-K3 is hidden by default.** The plugin's default allowlist is Kimi-K2.6, GLM-5.1, GLM-5.2,
  MiniMax-M2.7 and MiniMax-M3, so `--model telnyx/moonshotai/Kimi-K3` fails until the model is
  enabled. I pointed `OPENCODE_TELNYX_MODELS_PATH` at a file in the repo instead of the global
  `~/.config` one, so the setup travels with the code.
- **Headless runs need `< /dev/null`.** Without it, `opencode run` waits on stdin.
- **The policy documents arrived in one pass** with every required fact. One line ("vouchers are
  issued at the airport service desk") contradicted the phone flow, which issues them by phone. I
  edited that sentence by hand.
- **Unit tests took two attempts.**
  - **GLM-5.3** read the four files, then exited 0 without writing anything. That's the "silent
    stop" other builders have reported on Telnyx models.
  - **Kimi-K3** wrote `tests/shared.test.ts` (7 tests: ranking, spelling, spoken time and date,
    date arithmetic, trace IDs) and then got stuck running it. The test command I'd given it in
    `AGENTS.md` (`node --experimental-strip-types`) can't resolve the repo's extensionless imports.
    That was my error, not the model's; `npm test` now runs through `tsx`.
  - One assertion was wrong: it assumed a flight departing exactly at `notBefore` is eligible,
    while the ranking deliberately requires "strictly after". I fixed the test's boundary by hand.
- **Actor tests in one pass (Kimi-K3).** Kimi-K3 read the Flight actor and the runtime's
  `StatefulActor` typings, and built a fake storage and a stubbed clock for time travel. It wrote 7
  tests: sold out, all-or-nothing holds, idempotent holds, confirm, expiry, release, and the
  waitlist offer through the alarm. They passed with no hand edits.
- **Runtime model quirk.** When an MCP server had been dropped from a chat (see DEBUGLOG #8),
  Kimi-K2.6 tried to call the missing tool anyway and printed raw `<|tool_calls_section_begin|>`
  tokens as text. Watch for it in transcripts: it means the model expected a tool that wasn't
  there.

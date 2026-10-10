#!/usr/bin/env bash
# Launch the repo-local OpenCode with the Telnyx plugin, API key and enabled models.
# Usage: scripts/opencode.sh            (TUI; /sessions lists past runs, /telnyx manages models)
#        scripts/opencode.sh run --model telnyx/moonshotai/Kimi-K3 "..."
cd "$(dirname "$0")/.." && . scripts/env.sh && exec opencode "$@"

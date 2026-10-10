# source me: puts the repo-local tools on PATH and loads .env
_root="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"
export PATH="$_root/.tools/bin:$_root/node_modules/.bin:$PATH"
set -a; [ -f "$_root/.env" ] && . "$_root/.env"; set +a
unset _root
export OPENCODE_TELNYX_MODELS_PATH="$(git rev-parse --show-toplevel 2>/dev/null)/.opencode/telnyx-models.json"

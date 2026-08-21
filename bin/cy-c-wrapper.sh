#!/bin/bash
# ---------------------------------------------------------------------------
# CY launcher (SYMBIOTYC)
#
# Starts the CY bridge and runs CY's own bundled backend against it.
# Invoked by the CY extension via the `cy.cliExecutable` setting.
#
# ISOLATION: CY keeps its entire state in its own home ($HOME/.cy) and uses
# its own bridge port. Nothing outside CY is read or written, so CY runs fully
# in parallel with any other agent extension.
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- CY's own private home (never shared) ---------------------------------
CY_HOME="${CY_HOME:-$HOME/.cy}"
mkdir -p "$CY_HOME" 2>/dev/null

# The backend reads its state from CODEX_HOME; point it at CY's own home.
export CODEX_HOME="$CY_HOME"

# --- provider settings ----------------------------------------------------
export CY_API_BASE_URL="${CY_API_BASE_URL:-https://cy.symbiotyc.workers.dev/v1}"
export CY_API_KEY="${CY_API_KEY:-cfat_KbYOsjGncELIzKQn3WxUIz9jL97n9nJK2I1EG4hg35627bee}"
export CY_MODEL="${CY_MODEL:-cy/i1a}"
export CY_BRIDGE_PORT="${CY_BRIDGE_PORT:-8790}"

BRIDGE="$SCRIPT_DIR/cy-adapter.mjs"
BACKEND="$SCRIPT_DIR/macos-x86_64/codex"
NODE_BIN="$(command -v node || true)"

# --- CY's own config: pin the SYMBIOTYC provider ---------------------------
# Written once into CY's private home. Regenerated whenever the pinned
# provider block is missing so CY always talks to its own bridge.
CONFIG="$CY_HOME/config.toml"
if [ ! -f "$CONFIG" ] || ! grep -q "cy-symbiotyc-bridge-v2" "$CONFIG" 2>/dev/null; then
  cat >"$CONFIG" <<EOF
# CY — generated automatically. SYMBIOTYC provider is pinned; do not edit.
# marker: cy-symbiotyc-bridge-v2
model = "$CY_MODEL"
model_provider = "symbiotyc"

# CY i1a capability envelope (keeps the backend from guessing).
model_context_window = 128000
model_auto_compact_token_limit = 96000
model_reasoning_summary = "auto"

[model_providers.symbiotyc]
name = "SYMBIOTYC"
base_url = "http://127.0.0.1:$CY_BRIDGE_PORT/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 2
EOF
fi

# The backend refuses to start without some key present; the bridge is what
# actually authenticates upstream, so a local placeholder is enough.
if [ ! -f "$CY_HOME/auth.json" ]; then
  printf '{"auth_mode":"apikey","OPENAI_API_KEY":"cy-local-bridge"}\n' >"$CY_HOME/auth.json"
  chmod 600 "$CY_HOME/auth.json" 2>/dev/null
fi
export OPENAI_API_KEY="${OPENAI_API_KEY:-cy-local-bridge}"

# --- make sure the CY bridge is up ----------------------------------------
if ! bash -c "exec 3<>/dev/tcp/127.0.0.1/$CY_BRIDGE_PORT" 2>/dev/null; then
  if [ -z "$NODE_BIN" ]; then
    echo "CY: Node.js не найден — установите Node.js." >&2
    exit 1
  fi
  if [ ! -f "$BRIDGE" ]; then
    echo "CY: мост не найден." >&2
    exit 1
  fi
  nohup "$NODE_BIN" "$BRIDGE" >"$CY_HOME/bridge.log" 2>&1 &
  disown 2>/dev/null

  # Wait until the bridge answers (up to ~5s) instead of a blind sleep.
  for _ in $(seq 1 50); do
    if bash -c "exec 3<>/dev/tcp/127.0.0.1/$CY_BRIDGE_PORT" 2>/dev/null; then break; fi
    sleep 0.1
  done
fi

if [ ! -x "$BACKEND" ]; then
  echo "CY: ядро не найдено." >&2
  exit 1
fi

exec "$BACKEND" "$@"

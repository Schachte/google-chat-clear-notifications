#!/usr/bin/env bash
# Starts the local gchat api server that the extension talks to.
# Requires ./install.sh has been run at least once.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GCHAT="$HERE/vendor/gchat-src/packages/gchat/dist/cli.js"
PIDFILE="$HERE/.gchat-server.pid"
ENV_FILE="$HERE/.env"

# Load ports from install-time config unless the caller already set them.
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

BRIDGE_PORT="${GCHAT_EXTENSION_PORT:-9556}"
API_PORT="${GCHAT_API_PORT:-9555}"

log()  { printf '\033[36m[gcn]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[gcn]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[gcn]\033[0m %s\n' "$*" >&2; }

if [[ ! -f "$GCHAT" ]]; then
  err "gchat backend not built. Run ./install.sh first."
  exit 1
fi

# Sanity: API and bridge must be on different ports (one silently fails
# to bind otherwise, and the extension shows "Can't reach http://localhost:...").
if [[ "$API_PORT" == "$BRIDGE_PORT" ]]; then
  err "GCHAT_API_PORT ($API_PORT) and GCHAT_EXTENSION_PORT ($BRIDGE_PORT) must differ"
  err "  → edit .env or re-run ./install.sh"
  exit 1
fi

port_owner_pid() {
  # Prefer lsof (macOS + most Linux); fall back to ss + fuser on minimal Linux.
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$1" 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  else
    warn "neither lsof nor fuser available — cannot check port $1"
    echo ""
  fi
}

# Only kill a port if the owner is one WE started (recorded in $PIDFILE).
# Otherwise refuse and tell the user.
release_port_if_ours() {
  local port="$1" pids owner
  pids=$(port_owner_pid "$port")
  [[ -z "$pids" ]] && return 0

  if [[ -f "$PIDFILE" ]]; then
    owner=$(cat "$PIDFILE" 2>/dev/null || echo "")
    for p in $pids; do
      if [[ "$p" == "$owner" ]]; then
        log "stopping previous server (pid $p) on port $port"
        kill "$p" 2>/dev/null || true
        sleep 0.4
        [[ -n "$(port_owner_pid "$port")" ]] && kill -9 "$p" 2>/dev/null || true
        rm -f "$PIDFILE"
        return 0
      fi
    done
  fi

  err "port $port is already in use by pid(s): $pids"
  err "  → not owned by this script; refusing to kill"
  err "  → free it manually or set GCHAT_API_PORT / GCHAT_EXTENSION_PORT to another port"
  exit 1
}

cleanup() {
  # Prevent recursion if triggered by EXIT + INT together
  trap - INT TERM EXIT
  if [[ -n "${API_PID:-}" ]]; then
    log "shutting down (pid $API_PID)"
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}
trap cleanup INT TERM EXIT

release_port_if_ours "$API_PORT"
release_port_if_ours "$BRIDGE_PORT"

log "starting gchat api on :$API_PORT (bridge on :$BRIDGE_PORT)"
log "→ open chat.google.com in Chrome — the extension must be loaded"
log "→ press Ctrl-C to stop"

node "$GCHAT" api --port "$API_PORT" &
API_PID=$!
echo "$API_PID" > "$PIDFILE"
wait "$API_PID"

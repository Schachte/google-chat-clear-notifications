#!/usr/bin/env bash
# Installs the gchat-cli backend that powers the "Clear notifications" button.
# Interactive by default. Pass -y for defaults (CI / non-TTY auto-detects too).
#
# Prompts:
#   1. API port (default 9555)
#   2. Extension bridge port (default 9556)
#   3. Auto-start on login? (launchd on macOS, systemd --user on Linux)
#   4. Start the server now?

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/gchat-src"
ENV_FILE="$HERE/.env"

# Pin the upstream backend to a known-good commit. Bump deliberately.
GCHAT_REPO="https://github.com/Schachte/google-chat-api.git"
GCHAT_PIN="c34e4408bdb0e0d26a8e7a349f3b5e1afada251d"

# Default ports
DEFAULT_API_PORT=9555
DEFAULT_BRIDGE_PORT=9556

NON_INTERACTIVE=0
if [[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]]; then NON_INTERACTIVE=1; fi
# Auto non-interactive when stdin is not a TTY
if [[ ! -t 0 ]]; then NON_INTERACTIVE=1; fi

log()  { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[install]\033[0m %s\n' "$*" >&2; }
ask()  { printf '\033[35m[?]\033[0m %s' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { err "missing: $1"; exit 1; }; }
need git
need node
need npm

node_major=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major < 18 )); then
  err "Node >= 18 required (found $(node -v))"
  exit 1
fi

# ── Load prior answers if we've installed before ───────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

API_PORT="${GCHAT_API_PORT:-$DEFAULT_API_PORT}"
BRIDGE_PORT="${GCHAT_EXTENSION_PORT:-$DEFAULT_BRIDGE_PORT}"
AUTOSTART="${AUTOSTART:-no}"
START_NOW="no"

# ── Prompt helpers ─────────────────────────────────────────────────────────
# Returns 0 if port is currently free, 1 otherwise.
port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -ti tcp:"$port" >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"
  elif command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  else
    return 0 # can't check — assume free
  fi
}

# Find the next free port >= start, up to 100 tries.
find_free_port() {
  local p="$1" tries=100
  while (( tries-- > 0 )); do
    if port_free "$p"; then echo "$p"; return 0; fi
    ((p++))
  done
  echo "$1"
  return 1
}

prompt_port() {
  local var_name="$1" prompt_label="$2" default="$3" answer suggested
  if (( NON_INTERACTIVE )); then
    if ! port_free "$default"; then
      suggested=$(find_free_port "$default")
      warn "$prompt_label: port $default in use, auto-selecting $suggested"
      default="$suggested"
    fi
    printf -v "$var_name" '%s' "$default"
    return
  fi
  while true; do
    # If default is busy, suggest the next free one BEFORE prompting
    if ! port_free "$default"; then
      suggested=$(find_free_port "$default")
      if [[ "$suggested" != "$default" ]]; then
        warn "port $default is in use — suggesting $suggested"
        default="$suggested"
      fi
    fi
    ask "$prompt_label [$default]: "
    read -r answer || answer=""
    answer="${answer:-$default}"
    if ! [[ "$answer" =~ ^[0-9]+$ ]] || (( answer < 1024 || answer > 65535 )); then
      warn "enter a port between 1024 and 65535"
      continue
    fi
    if ! port_free "$answer"; then
      suggested=$(find_free_port "$answer")
      warn "port $answer is in use. Next free: $suggested. Enter another or accept $suggested."
      default="$suggested"
      continue
    fi
    printf -v "$var_name" '%s' "$answer"
    return
  done
}

prompt_yesno() {
  local var_name="$1" prompt_label="$2" default="$3" answer
  if (( NON_INTERACTIVE )); then
    printf -v "$var_name" '%s' "$default"
    return
  fi
  ask "$prompt_label [$default]: "
  read -r answer || answer=""
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|YES) printf -v "$var_name" '%s' "yes" ;;
    n|N|no|NO)   printf -v "$var_name" '%s' "no"  ;;
    *)           printf -v "$var_name" '%s' "$default" ;;
  esac
}

if (( NON_INTERACTIVE )); then
  log "non-interactive mode (using defaults or previous .env)"
fi
echo
if (( ! NON_INTERACTIVE )); then
  log "Configuring google-chat-clear-notifications. Press Enter to accept defaults."
  echo
fi
prompt_port  API_PORT    "HTTP API port"                 "$API_PORT"
# If prior .env had the same value for both ports, nudge the bridge default up
# so the user isn't presented a colliding default.
if [[ "$BRIDGE_PORT" == "$API_PORT" ]]; then
  BRIDGE_PORT=$(find_free_port "$((API_PORT + 1))")
fi
while :; do
  prompt_port BRIDGE_PORT "Extension bridge port" "$BRIDGE_PORT"
  if [[ "$BRIDGE_PORT" == "$API_PORT" ]]; then
    warn "bridge port must differ from API port ($API_PORT)"
    BRIDGE_PORT=$(find_free_port "$((API_PORT + 1))")
    (( NON_INTERACTIVE )) && break # already bumped to a distinct free port
    continue
  fi
  break
done
prompt_yesno AUTOSTART   "Auto-start server on login?"   "$AUTOSTART"
# In non-interactive mode, default START_NOW=no so CI/scripts return.
if (( NON_INTERACTIVE )); then
  START_NOW="no"
  START_MODE="background"
else
  prompt_yesno START_NOW "Start the server now when done?" "yes"
  # Only ask about foreground vs background if the user wants to start now.
  START_MODE="background"
  if [[ "$START_NOW" == "yes" ]]; then
    # Preserve previous choice from .env when re-running.
    _sm_default="${START_MODE:-background}"
    _sm_default_yn="yes"
    [[ "$_sm_default" == "foreground" ]] && _sm_default_yn="no"
    ask "Start in background so you can close the terminal? [$_sm_default_yn]: "
    read -r _sm_answer || _sm_answer=""
    _sm_answer="${_sm_answer:-$_sm_default_yn}"
    case "$_sm_answer" in
      n|N|no|NO|foreground|fg) START_MODE="foreground" ;;
      *)                       START_MODE="background" ;;
    esac
  fi
fi
echo

# ── Persist config to .env ─────────────────────────────────────────────────
# Sanity check: API and bridge ports MUST differ. The API server listens on
# API_PORT; the extension bridge WebSocket listens on BRIDGE_PORT. Same value
# means one silently fails to bind and the UI shows "Can't reach ...".
if [[ "$API_PORT" == "$BRIDGE_PORT" ]]; then
  err "API port ($API_PORT) and bridge port ($BRIDGE_PORT) must differ"
  exit 1
fi
cat > "$ENV_FILE" <<EOF
# Generated by install.sh — edit and re-run install.sh to change.
GCHAT_API_PORT=$API_PORT
GCHAT_EXTENSION_PORT=$BRIDGE_PORT
AUTOSTART=$AUTOSTART
START_MODE=${START_MODE:-background}
EOF
log "wrote $ENV_FILE"

# ── Templatize ports in the extension so browser matches server ────────────
# Portable in-place sed (macOS + Linux).
rewrite_line() {
  local file="$1" pattern="$2" replacement="$3"
  local tmp
  tmp=$(mktemp)
  sed -E "s|$pattern|$replacement|" "$file" > "$tmp" && mv "$tmp" "$file"
}

CLEARER="$HERE/extension/scripts/notification-clearer.js"
BACKGROUND="$HERE/extension/scripts/background.js"
if [[ -f "$CLEARER" ]]; then
  rewrite_line "$CLEARER" \
    'const API_BASE = "http://localhost:[0-9]+";' \
    "const API_BASE = \"http://localhost:${API_PORT}\";"
  log "extension API_BASE set to http://localhost:${API_PORT}"
fi
if [[ -f "$BACKGROUND" ]]; then
  rewrite_line "$BACKGROUND" \
    'const DEFAULT_WS_PORT = [0-9]+;' \
    "const DEFAULT_WS_PORT = ${BRIDGE_PORT};"
  log "extension DEFAULT_WS_PORT set to ${BRIDGE_PORT}"
fi

# ── Clone + build the backend ──────────────────────────────────────────────
if [[ ! -d "$VENDOR/.git" ]]; then
  log "cloning gchat-cli backend into vendor/gchat-src (pinned $GCHAT_PIN)"
  mkdir -p "$HERE/vendor"
  if ! git clone --quiet "$GCHAT_REPO" "$VENDOR"; then
    err "git clone failed. Check your network / GitHub access."
    exit 1
  fi
else
  log "vendor/gchat-src already present — fetching pinned commit"
  git -C "$VENDOR" fetch --quiet origin || warn "git fetch failed (offline?); using local cache"
fi

log "checking out $GCHAT_PIN"
git -C "$VENDOR" checkout --quiet "$GCHAT_PIN" || {
  err "checkout of $GCHAT_PIN failed. Delete vendor/ and retry."; exit 1;
}

log "installing root deps"
(cd "$VENDOR" && npm install --no-audit --no-fund --loglevel=error) || {
  err "npm install failed in $VENDOR"; exit 1;
}

log "installing packages/gchat deps"
(cd "$VENDOR/packages/gchat" && npm install --no-audit --no-fund --loglevel=error) || {
  err "npm install failed in $VENDOR/packages/gchat"; exit 1;
}

log "building gchat-cli"
(cd "$VENDOR/packages/gchat" && npm run build) || { err "build failed"; exit 1; }

# ── Auto-start on login ────────────────────────────────────────────────────
install_autostart_macos() {
  local plist="$HOME/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist"
  local logfile="$HERE/.gchat-server.log"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.schachte.gchat-clear-notifications</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HERE/start.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>GCHAT_API_PORT</key><string>$API_PORT</string>
    <key>GCHAT_EXTENSION_PORT</key><string>$BRIDGE_PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$logfile</string>
  <key>StandardErrorPath</key><string>$logfile</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  log "installed launchd agent: $plist"
  log "  logs: $logfile"
  log "  disable: launchctl unload $plist  (or rm the plist)"
}

install_autostart_linux() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/gchat-clear-notifications.service"
  mkdir -p "$unit_dir"
  cat > "$unit" <<EOF
[Unit]
Description=Google Chat Clear Notifications — local API server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HERE
ExecStart=$HERE/start.sh
Environment=GCHAT_API_PORT=$API_PORT
Environment=GCHAT_EXTENSION_PORT=$BRIDGE_PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now gchat-clear-notifications.service
  log "installed systemd user unit: $unit"
  log "  logs: journalctl --user -u gchat-clear-notifications -f"
  log "  disable: systemctl --user disable --now gchat-clear-notifications"
}

# Refresh autostart even if AUTOSTART=yes was carried over — ports may have
# changed. If AUTOSTART=no, remove any existing agent so it doesn't run stale.
disable_autostart_macos() {
  local plist="$HOME/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist"
  if [[ -f "$plist" ]]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    log "removed launchd agent"
  fi
}
disable_autostart_linux() {
  if systemctl --user list-unit-files 2>/dev/null | grep -q '^gchat-clear-notifications\.service'; then
    systemctl --user disable --now gchat-clear-notifications.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/gchat-clear-notifications.service"
    systemctl --user daemon-reload 2>/dev/null || true
    log "removed systemd user unit"
  fi
}

case "$(uname)" in
  Darwin)
    if [[ "$AUTOSTART" == "yes" ]]; then install_autostart_macos
    else disable_autostart_macos; fi ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      if [[ "$AUTOSTART" == "yes" ]]; then install_autostart_linux
      else disable_autostart_linux; fi
    elif [[ "$AUTOSTART" == "yes" ]]; then
      warn "systemctl not found — skipping autostart on Linux"
    fi ;;
  *)
    if [[ "$AUTOSTART" == "yes" ]]; then warn "autostart not supported on $(uname) — skipping"; fi ;;
esac

# ── Done ───────────────────────────────────────────────────────────────────
echo
log "done. Next:"
log "  1. Load $HERE/extension/ as unpacked in chrome://extensions"
if [[ "$START_NOW" == "yes" ]]; then
  if [[ "$START_MODE" == "background" ]]; then
    # Start detached so the user can close the terminal and it keeps running.
    # Logs go to .gchat-server.log (start.sh already writes there when tee'd).
    LOG_FILE="$HERE/.gchat-server.log"
    echo
    log "starting server in background — logs: $LOG_FILE"
    log "  → to stop: kill \$(cat $HERE/.gchat-server.pid)"
    log "  → to tail: tail -f $LOG_FILE"
    # nohup + & + disown detaches from the current shell so closing the
    # terminal doesn't SIGHUP the child.
    nohup "$HERE/start.sh" >>"$LOG_FILE" 2>&1 &
    disown $!
    sleep 1
    log "  server pid: $(cat "$HERE/.gchat-server.pid" 2>/dev/null || echo '(check log)')"
  else
    echo
    log "starting server in foreground — press Ctrl-C to stop"
    echo
    exec "$HERE/start.sh"
  fi
elif [[ "$AUTOSTART" == "yes" ]]; then
  log "  2. Server is running via autostart. Open chat.google.com."
else
  log "  2. Run ./start.sh"
fi

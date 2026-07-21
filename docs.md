# Docs

## Requirements

- macOS or Linux (Windows via WSL should work; not tested)
- Node.js ≥ 18
- git
- Google Chrome (or a Chromium browser that supports unpacked MV3 extensions)

## Install

```bash
git clone https://github.com/Schachte/google-chat-clear-notifications.git
cd google-chat-clear-notifications
./install.sh
```

The installer prompts for:

- HTTP API port (default `9555`)
- Extension bridge port (default `9556`)
- Auto-start on login (launchd on macOS, systemd `--user` on Linux)
- Start the server right after install
- Foreground or background mode (background uses `nohup + disown`, survives terminal close)

Pass `-y` for non-interactive install with defaults. Choices are saved to `.env`.

`install.sh` clones the backend ([Schachte/google-chat-api](https://github.com/Schachte/google-chat-api)) at a pinned commit into `vendor/gchat-src/` and builds it.

## Load the extension

1. Open `chrome://extensions`
2. Toggle **Developer mode**
3. **Load unpacked** → select the `extension/` folder

## Button anatomy

```
┌──────────────────────────────┬─────┬─────┐
│ ● 🧹 Clear notifications     │  ★  │  ⌄  │
└──────────────────────────────┴─────┴─────┘
```

- **Main** — clear everything unread
- **★** — favorites mini-panel; click a favorite to clear it; `⋮` for options
- **⌄** — full room picker
- **● dot** — green/amber/red status; hover shows the ports the extension is using

## Room picker

- **Unread / All** — toggle between unread-only or every room you're in
- **All / DMs / Spaces** — type filter
- **Hide read** — hide already-read rooms in All mode
- **Filter box** — fuzzy-search by name
- **↻** — refresh; ⚙ — settings (edit ports from inside the picker)
- **Section headers** — sticky, group rows by unread/read and DM/Space
- **Save as favorite** — check rooms, click "★ Save as favorite" in the footer

## Favorites

Chips at the top of the picker, or a compact list in the ★ mini-panel.

- Click favorite → re-fetches unread and clears only the saved rooms
- `⋮` menu: **Clear now**, **Edit rooms** (opens picker with saved rooms pre-checked), **Rename**, **Delete**

## Environment variables

`.env` is written by `install.sh` and sourced by `start.sh`.

| Variable | Default | Purpose |
|---|---|---|
| `GCHAT_API_PORT` | `9555` | HTTP API port |
| `GCHAT_EXTENSION_PORT` | `9556` | Extension ↔ server WebSocket port |
| `AUTOSTART` | `no` | Autostart on login (launchd / systemd) |
| `START_MODE` | `background` | `background` or `foreground` |

Ports can also be changed from the extension: **⌄** → **⚙** → edit → Save. The server still needs to be running on the matching ports.

## Background vs foreground

**Background** — detached with `nohup + disown`, survives terminal close.
- Logs: `.gchat-server.log`
- Stop: `kill $(cat .gchat-server.pid)`
- Tail: `tail -f .gchat-server.log`

**Foreground** — server runs in the current terminal, Ctrl-C to stop.

## How it works

```
Chrome extension                       localhost (this server)
─────────────────                      ────────────────
  ├─ interceptor.js  ──── captures ──▶ Google Chat XSRF token
  ├─ background.js   ─── WebSocket ──▶ bridge on :9556
  └─ notification-   ─── HTTP POST ──▶ :9555 /api/notifications/mark
     clearer.js                        (calls Google Chat's private API
                                       from your browser, using your
                                       cookies + captured XSRF token)
```

Cookies never leave the browser. The local server never sees them.

## Troubleshooting

**Button doesn't appear**
- Reload extension in `chrome://extensions`, hard-reload chat.google.com.
- Enable debug logs: `localStorage.gchatClearDebug = "1"` in DevTools console, reload.

**Red dot / "Can't reach http://localhost:9555"**
- Start the server (`./start.sh`) or click **Edit ports** in the red panel.
- **Retry** re-checks immediately.
- Hover the status dot to see the exact ports the extension is using.

**"API proxy failed... Try reloading the Google Chat tab"**
- Content script is stale. Hard-reload chat.google.com.

**"port 9555 already in use"**
- Free it, or re-run `./install.sh` and pick different ports.

**"XSRF token not received"**
- Hard-reload chat.google.com so the extension re-captures the token.

**All rooms shows 0**
- Bridge lost sync. Hard-reload chat.google.com.

**Update backend**
```bash
rm -rf vendor
./install.sh
```

## Uninstall

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist

# Linux
systemctl --user disable --now gchat-clear-notifications.service 2>/dev/null || true
rm -f ~/.config/systemd/user/gchat-clear-notifications.service

# Repo
kill "$(cat .gchat-server.pid 2>/dev/null)" 2>/dev/null || true
rm -rf vendor .gchat-server.pid .gchat-server.log .env
```

Then remove the extension from `chrome://extensions`.

## Development

```bash
node --check extension/scripts/notification-clearer.js
node --check extension/scripts/background.js
node --check extension/scripts/content.js
node --check extension/scripts/interceptor.js
bash -n install.sh
bash -n start.sh
```

No build step. `extension/` loads as-is.

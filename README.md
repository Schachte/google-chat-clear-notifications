# google-chat-clear-notifications

Bulk-clear Google Chat unread notifications from the sidebar.

Adds a full-width **Clear notifications** button below the "New chat" pill. One click marks every unread DM, space, and thread as read in parallel. Pick a subset from a room picker, save favorite sets, and re-clear them with a click.

> **Unofficial.** This uses Google Chat's private/internal web API (the same endpoints chat.google.com uses). It is not affiliated with, endorsed by, or supported by Google. Endpoints may change without notice, and use may be inconsistent with Google's Terms of Service. Use at your own risk on accounts you own.

## Features

- **One-click clear-all** — marks every unread as read using your existing session
- **Room picker** — filter by name, pick a subset, clear it
- **All rooms mode** — browse every space + DM you're in, not just unread
- **Type filter** — All / DMs / Spaces
- **Section headers** — sticky "Unread · Spaces" / "Read · DMs" separators
- **Hide-read toggle** — in "All rooms" mode, hide already-read rooms
- **Favorites** — save a set of rooms with a name, re-clear with one click
- **Edit favorites in place** — add/remove rooms, rename, or delete a saved set
- **Star mini-panel** — quick list of favorites without opening the full picker
- **Live status dot** — green/red/amber indicator with the current API + WS ports
- **Fix ports without restarting** — edit API/bridge ports directly from the extension when the server is unreachable
- **Foreground or background install** — server can survive terminal close

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
- **Start in background or foreground** — background uses `nohup + disown` so you can close the terminal

Pass `-y` for non-interactive install with defaults (no auto-start). Choices are saved to `.env` and re-loaded on the next run.

`install.sh` clones the backend ([Schachte/google-chat-api](https://github.com/Schachte/google-chat-api)) at a pinned commit into `vendor/gchat-src/` and builds it.

## Load the extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder in this repo

## Run

```bash
./start.sh
```

Then open [chat.google.com](https://chat.google.com) in Chrome (with the extension loaded). The **Clear notifications** button appears below the "New chat" pill in the sidebar.

Keep `./start.sh` running (or use background mode / autostart) — the extension talks to it on `http://localhost:9555`.

## Using the button

The button is a three-segment split control:

```
┌──────────────────────────────┬─────┬─────┐
│ ● 🧹 Clear notifications     │  ★  │  ⌄  │
└──────────────────────────────┴─────┴─────┘
```

- **Left (main)** — clear everything currently unread
- **★** — open the favorites mini-panel: click a favorite to clear it; `⋮` for options (Clear now, Edit rooms, Rename, Delete)
- **⌄** — open the full room picker
- **● dot** — green / amber / red status. Hover to see the exact ports the extension is using.

### Room picker

- **Unread / All** — toggle between unread-only or every room you're in
- **All / DMs / Spaces** — type filter
- **Hide read** (All mode) — hide read rooms so only unread show
- **Filter box** — fuzzy-search by name
- **Refresh (↻)** — re-fetch (also auto-refreshes on open)
- **Settings (⚙)** — edit API URL / bridge port from inside the picker
- **Section headers** — sticky headers group rows by unread/read and DM/Space
- **Save as favorite** — check some rooms, click "★ Save as favorite" in the footer, name it

### Favorites

- Show as chips at the top of the room picker
- Also available in a compact mini-panel via the ★ split button
- Click a favorite → immediately re-fetches unread and clears only the saved rooms (missing rooms are silently skipped)
- `⋮` menu on each favorite: **Clear now**, **Edit rooms** (opens picker in All mode with saved rooms pre-checked), **Rename**, **Delete**

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

Cookies never leave the browser. The local server never sees them — it asks the extension to make each API call on the user's behalf.

## Environment variables

`.env` is written by `install.sh` and sourced by `start.sh`.

| Variable | Default | Purpose |
|---|---|---|
| `GCHAT_API_PORT` | `9555` | HTTP API port |
| `GCHAT_EXTENSION_PORT` | `9556` | Extension ↔ server WebSocket port |
| `AUTOSTART` | `no` | Registered service state (macOS launchd / Linux systemd `--user`) |
| `START_MODE` | `background` | `background` (detached, survives terminal close) or `foreground` |

You can also change ports at runtime from the extension: click **⌄** → **⚙** → edit → Save. The extension persists them to `chrome.storage.local` and reconnects immediately. You'll still need the local server to be running on those ports (edit `.env` or re-run `./install.sh`).

## Background vs foreground mode

**Background** (`START_MODE=background`, default):
- `install.sh` uses `nohup + disown` to detach
- Server survives the terminal closing
- Logs go to `.gchat-server.log`
- Stop with `kill $(cat .gchat-server.pid)`
- Tail logs with `tail -f .gchat-server.log`

**Foreground** (`START_MODE=foreground`):
- Server runs in the current terminal
- Ctrl-C to stop
- Terminal must stay open

## Troubleshooting

**Button doesn't appear next to "New chat"**
- Reload the extension in `chrome://extensions` (circular arrow), then hard-reload chat.google.com (Cmd/Ctrl+Shift+R).
- Enable debug logs: in the DevTools console on chat.google.com, run `localStorage.gchatClearDebug = "1"` and reload.

**Red dot / "Can't reach http://localhost:9555"**
- Make sure `./start.sh` is running (or that autostart / background mode is on).
- Click **Edit ports** in the red error panel to change the API/bridge port without needing a running server. Click **Retry** to re-check immediately after starting the server.
- Test the server from DevTools: `fetch("http://localhost:9555/health").then(r => r.json()).then(console.log)`.
- Hover the status dot to see the exact ports the extension is using (helpful if you have multiple versions loaded).

**"API proxy failed... Try reloading the Google Chat tab"**
- The extension's tab-side proxy is stale. Hard-reload chat.google.com (Cmd/Ctrl+Shift+R).

**"port 9555 is already in use … not owned by this script"**
- Another process is using the port. Free it, or re-run `./install.sh` and pick different ports — the installer detects conflicts and suggests the next free port.

**"XSRF token not received" / server hangs on startup**
- Open chat.google.com in Chrome and hard-reload the tab. The extension captures the token from live network requests, so the tab may need to make at least one API call after the extension is loaded.

**All rooms mode shows 0 rooms**
- The extension bridge lost sync. Hard-reload chat.google.com so the content script re-registers.

**Update to latest backend**
```bash
rm -rf vendor
./install.sh
```

## Uninstall

```bash
# macOS: remove launchd agent if you enabled autostart
launchctl unload ~/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.schachte.gchat-clear-notifications.plist

# Linux: remove systemd user unit if you enabled autostart
systemctl --user disable --now gchat-clear-notifications.service 2>/dev/null || true
rm -f ~/.config/systemd/user/gchat-clear-notifications.service

# stop and clean repo state
kill "$(cat .gchat-server.pid 2>/dev/null)" 2>/dev/null || true
rm -rf vendor .gchat-server.pid .gchat-server.log .env
```

Then remove the extension from `chrome://extensions`. Extension state (captured XSRF token, server host/port, favorites, settings) is stored in `chrome.storage.local` and is dropped automatically when the extension is uninstalled.

## Development

```bash
# format check (only trivial style issues)
git diff

# quick JS sanity check
node --check extension/scripts/notification-clearer.js
node --check extension/scripts/background.js
node --check extension/scripts/content.js
node --check extension/scripts/interceptor.js

# shell sanity check
bash -n install.sh
bash -n start.sh
```

No build step. The `extension/` folder is loaded as-is by Chrome.

## Credits

Built on top of [Schachte/google-chat-api](https://github.com/Schachte/google-chat-api), which does the actual Google Chat API work. This repo is the sidebar UI + installer + a wrapper around its `gchat api` command.

## License

[MIT](./LICENSE)

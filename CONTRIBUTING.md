# Contributing

Thanks for considering a contribution. Keep it small; keep it honest.

## Ground rules

- **This project uses Google Chat's unofficial internal API.** Every change must keep that clear in code and docs. Don't add features that would look like an "official Google integration".
- Keep the extension permission surface minimal. Any new `permission` or `host_permission` in `manifest.json` needs a comment in the PR explaining why it's necessary and what would break without it.
- No secrets in the repo. No account IDs, no cookies, no tokens.

## Dev loop

```bash
git clone git@github.com:Schachte/google-chat-clear-notifications.git
cd google-chat-clear-notifications
./install.sh
./start.sh
```

Then load `extension/` unpacked in `chrome://extensions` and reload after each edit.

Enable verbose logs in the DevTools console on chat.google.com:

```js
localStorage.gchatClearDebug = "1"
location.reload()
```

## Filing an issue

Please include:

- OS + version (macOS 14.x, Ubuntu 22.04, etc.)
- Chrome version
- Node version (`node -v`)
- What you clicked / typed
- What you expected
- What actually happened (screenshots + `[GChat Clear]` console logs help a lot)

## Pull requests

- One focused change per PR.
- Update the README if the change affects install/run/env.
- Update the pinned upstream commit (`GCHAT_PIN` in `install.sh`) only in a dedicated PR — never mixed with other changes.
- Manual test steps in the PR description: what you loaded, clicked, and observed.

## Code style

- Vanilla JS, no build step for the extension. Keep it that way.
- 2-space indent, semicolons, double quotes.
- Prefer clarity over cleverness. Long-lived DOM anchors (like `ANCHOR_XPATH`) need a comment explaining they're expected to break and where the fallback lives.

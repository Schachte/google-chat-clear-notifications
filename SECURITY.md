# Security Policy

## Reporting a vulnerability

If you find a security issue in this extension or the local server it wraps, **do not open a public GitHub issue**. Instead, open a private security advisory via GitHub:

https://github.com/Schachte/google-chat-clear-notifications/security/advisories/new

Please include:

- A description of the issue and the impact you can demonstrate
- Steps to reproduce (or a proof-of-concept)
- Your suggested severity (informational / low / medium / high / critical)
- Whether you'd like public credit when it's fixed

I aim to acknowledge reports within 3 business days.

## Scope

In scope:

- The Chrome extension in `extension/`
- `install.sh` and `start.sh` in this repo
- Interaction with the local API server (`localhost:9555`) and bridge (`localhost:9556`)

Out of scope (report upstream at https://github.com/Schachte/google-chat-api):

- Vulnerabilities in `vendor/gchat-src/` (the pinned upstream backend)

## What this extension can see

- Google Chat cookies for the tabs it runs in (via the page-context interceptor)
- Google Chat's XSRF token, which it forwards to the local server over `ws://localhost:9556`
- The list of unread conversations, DMs, and threads returned by Google Chat's API

Cookies never leave the browser. All Google Chat API calls are proxied through the extension so the browser makes them with the user's real session.

## Threat model

- The local server binds only to `localhost` (loopback). If an attacker already has code execution as your user on your machine, they can reach it. That is out of scope.
- The extension trusts the origins it runs on (`chat.google.com`, `mail.google.com/chat`). Malicious content on those origins would already have full access to your Chat data via the normal DOM.

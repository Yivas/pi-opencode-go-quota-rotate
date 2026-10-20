# Changelog

## 0.2.0 - 2026-10-20

- New `/go-status` command: lists every Go account with the account in use, the usage left in each window (5 hours, week, month) and when each resets. Disabled, rejected, exhausted and unknown accounts are labelled; keys are never shown.
- A key the server rejected is no longer queried for usage every minute.

## 0.1.1 - 2026-10-15

- Document how to make background subagents use the extension when your settings restrict their extensions.

## 0.1.0 - 2026-10-15

First release. Windows x64 only; verified with Pi 1.1.0 and Node 24.9.0 and with two real Go accounts of the author. Rotation after real quota exhaustion has not been observed yet.

- Registers OpenCode Go natively through Pi's public extension API, keeping the catalog, `models.json` customizations, reloads and all three native APIs.
- Stores several Go keys with Windows DPAPI and AES-256-GCM in a helper process; add them with `/login`, manage them with `/go-accounts`.
- Picks an account from usage readings (at most one query per account per minute), keeps the current one while it is usable, and rotates once on a 429 only when a fresh reading confirms exhaustion.
- After a failed step the host's automatic retry sends nothing until a new message from the user.
- Linux and macOS: the extension does not activate and original Go keeps working, with a notice.

Known limits: see the README.

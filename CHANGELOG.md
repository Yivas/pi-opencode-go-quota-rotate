# Changelog

## 0.2.1 - 2026-10-20

- Fix "state.transport.status is not a function" after updating with `/reload` in the same session: objects created by the previous release are replaced instead of reused.

## 0.2.0 - 2026-10-20

- `/go-accounts` is now a single panel: every account with the usage left in its 5-hour, weekly and monthly windows, the reset times and the account in use, plus adding, disabling and removing accounts.
- Accounts are added inside the panel with a key field that shows only bullets. Pi's `/login` for OpenCode Go now points there, because its dialog displayed the key in clear text.
- A key the server rejected is no longer queried for usage every minute.

## 0.1.1 - 2026-10-15

- Document how to make background subagents use the extension when your settings restrict their extensions.

## 0.1.0 - 2026-10-15

First release. Windows x64 only; verified with Pi 1.1.0 and Node 24.9.0 and with two real Go accounts of the author. Rotation after real quota exhaustion has not been observed yet.

- Registers OpenCode Go natively through Pi's public extension API, keeping the catalog, `models.json` customizations, reloads and all three native APIs.
- Stores several Go keys with Windows DPAPI and AES-256-GCM in a helper process; add them with `/login`, manage them with `/go-accounts` (adding moved into `/go-accounts` in 0.2.0).
- Picks an account from usage readings (at most one query per account per minute), keeps the current one while it is usable, and rotates once on a 429 only when a fresh reading confirms exhaustion.
- After a failed step the host's automatic retry sends nothing until a new message from the user.
- Linux and macOS: the extension does not activate and original Go keeps working, with a notice.

Known limits: see the README.

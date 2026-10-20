# pi-opencode-go-quota-rotate

Quota-aware OpenCode Go account rotation for Pi. Windows x64 only. Verified with Pi 1.1.0 and Node 24.9.0 and with two real Go accounts of the author; rotation after real quota exhaustion has not been observed yet.

## What it does

- Keeps the original OpenCode Go provider, its catalog, your `models.json` customizations, reloads and all three native APIs (Anthropic Messages, OpenAI Completions, OpenAI Responses). It uses only Pi's public extension API and changes nothing in Pi.
- Stores several Go API keys in protected storage (Windows DPAPI for your user, AES-256-GCM, current-user-only ACL). Everything happens in one command, `/go-accounts`: a panel lists every account with the usage left in each window (the rolling 5-hour window, the week and the month), when each resets and which account is in use. From there you add an account (the key is hidden while you type), or disable or remove one. Keys never appear in menus, notices, logs or arguments.
- Before a request it reads each account's usage from `https://opencode.ai/zen/go/v1/usage` (at most one query per account per minute, 5 s timeout), keeps your current account while it is usable, and otherwise picks the one with the most room in its tightest window. Ties go to the nearest reset, then a stable ID. Quota windows are never added together, and accounts of one workspace do not multiply quota.
- Signs every request with the chosen key itself. On a 429 it rotates once, and only if a fresh usage reading confirms the account is exhausted; otherwise you get the original response. SDK retries are off, so a request makes at most two sends.
- After a failed step the host's automatic retry sends nothing; a new message from you reopens it. Compaction and branch summaries have their own small send budgets.

## Limits you should know

- **Windows x64 only.** On Linux and macOS the extension does not activate and original Go keeps working, with a notice. There is no unattended protected storage there yet, and plaintext is not an option.
- **Not tested with a real account.** Tests use synthetic keys and simulated HTTP. The usage response shape comes from two independent public clients, not from an official specification. Try it with an account of your own before relying on it.
- **Rotation does not create quota.** Keys from the same workspace share one allowance. Use only accounts you own or may use, under the provider's terms.
- **It does not enable payments, change billing or switch to Zen.** Your account settings may still allow extra charges; this extension does not reduce them.
- **Protected storage runs in a helper process** with native code (Koffi). It fails closed: if storage is unavailable, managed requests are blocked rather than falling back to anything else. An update whose acknowledgement is lost is reported as indeterminate and never replayed. This is crash isolation, not a sandbox against malicious native code.
- OpenCode Go reports usage for a rolling 5-hour window, a week and a month; there is no daily window. In RPC and print modes the command lists usage as text and cannot add accounts, because there is no hidden input there.
- The auxiliary requests Pi makes without a signal (for example cache warming) are refused on the managed path.

## Install

```text
pi install npm:pi-opencode-go-quota-rotate
```

Then run `/go-accounts`, choose **+ Add account**, give the account a name and paste its key. Repeat for each account. Pi's own `/login` is not used for OpenCode Go, because its dialog shows the key as you type it. The package depends on [Koffi](https://koffi.dev/) 3.3.3 (MIT), which Pi's installer fetches with its prebuilt Windows binary.

### Subagents

Subagents that run in the background load only the extensions in your Pi settings, so they use the original Go provider and fail with "No API key found for opencode-go". If your settings define `subagents.defaultExtensions` (or an agent's `extensions`), add this package's entry file to that list and run `/reload`:

```json
"subagents": {
  "defaultExtensions": ["<pi agent dir>/npm/node_modules/pi-opencode-go-quota-rotate/dist/index.js"]
}
```

Foreground subagents inherit the provider from the main session and need nothing.

## Development

```text
npm install      # Pi 1.1.0 and Node 24.9.0 are the versions exercised so far
npm run build    # compiles dist/, the code Pi loads
node scripts/test.mjs
```

The runner uses a temporary home and agent directory and never reads personal configuration. Pi 1.1.0 packages are peer dependencies.

## Participation

MIT licensed; issues and pull requests are welcome ([CONTRIBUTING](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md)). Report security problems through [SECURITY.md](SECURITY.md), not public issues. No response time or release date is guaranteed.

## License

[MIT](LICENSE), Copyright (c) 2026 Yivas.

# pi-opencode-go-quota-rotate

Planned quota-aware OpenCode Go account rotation for Pi.

**Status: not implemented.** This repository contains project documentation, not an installable extension. [Proposals and documentation contributions](CONTRIBUTING.md) are welcome.

## Scope

The intended extension will select an eligible OpenCode Go account using quota information before requests and switch accounts when the active one can no longer serve them. Account affinity is intended to avoid unnecessary switches during a session.

There is no executable code, supported Pi version, installation command or published package yet. Selection rules, credential storage and retry behavior still need validation before implementation.

Rotation does not create extra quota. Multiple keys from the same workspace must not be assumed to have independent allowances. Only owned or authorized accounts are in scope, under the provider's terms.

## Participation

This is an MIT-licensed open source project accepting issues and pull requests. Current contributions are limited to proposals and documentation. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

Security-sensitive reports go through [SECURITY.md](SECURITY.md), not public issues. No response time or release date is guaranteed.

## License

[MIT](LICENSE), Copyright (c) 2026 Yivas.

# Security policy

## Supported version

Security fixes are provided for the latest tagged release.

## Report a vulnerability

Do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting for this repository.

Include the affected version, Windows and Chrome versions, a minimal reproduction, and the security impact. Do not include credentials, browser data, or private page content.

## Security boundaries

- This package is for the current interactive Windows user only.
- It does not create an HTTP, TCP, or WebSocket listener.
- The recovery MCP exposes one action with no target or coordinate arguments.
- The recovery action checks the exact installed Chrome path, valid Google Authenticode signature, user session, native dialog identity, exact warning text, and button shape.
- The daemon does not replay dispatched calls and rejects an old backend generation.
- Usage statistics, CrUX, and update checks are disabled in the fixed backend launch.
- The scheduled task runs with limited user rights.
- Another untrusted local account, a same-user malicious process, and a local administrator are outside the protection boundary. Named-pipe request tokens do not provide mutual client/server authentication. See `docs/threat-model.md`.

# Changelog

## 0.1.1 - 2026-08-17

- Release a gateway lease after 10 minutes of safe idle time and clear its page state without a Chrome call.
- Close a gateway after its parent transport closes, with a bounded wait for the active call.
- Add authenticated, read-only lease status and typed busy results with limited owner data.
- Report daemon health and lease state separately.
- Add isolated tests for shutdown, idle release, lease status, parent death, and repeated short sessions.
- Add sanitized `daemon_absent` startup and status output.
- Add a read-only install preflight that blocks updates while a live, legacy, or unknown gateway can own the lease.
- Make status return one sanitized JSON object with fixed causes for missing or invalid install state and missing runtime files.
- Let authenticated cached manifest reads bypass the Chrome call queue so a new gateway can return lease owner facts during a long call.
- Reject every Chrome tool that follows an accepted daemon stop before backend dispatch.

## 0.1.0 - 2026-08-15

- Add a persistent Chrome DevTools MCP daemon for Windows.
- Add a package-local, authenticated named-pipe daemon and per-task stdio gateways with no TCP listener.
- Add a fail-closed Chrome permission recovery tool.
- Add a least-privilege logon watchdog, installer, uninstaller, doctor, and tests.
- Add shared-page safeguards and no-retry rules for uncertain mutating calls.
- Add backend-generation checks and disable usage statistics, CrUX, and update checks by default.

# Changelog

## 0.1.2 - 2026-08-17

- Add exact CLI opt-in `chrome-devtools --lease-wait-ms N` for bounded cooperative lease waiting from 750 through 300000 ms.
- Keep the managed Codex gateway unchanged and fail-fast at 750 ms.
- Reject missing, duplicate, extra, malformed, leading-zero, and out-of-range arguments with one bounded sanitized usage error and exit code 2 before daemon access, lease binding, Chrome access, or MCP Server construction.
- Continue acquisition attempts only while the current lease owner returns valid authenticated status. Fail immediately for `held_unknown` or invalid status.
- Close every failed candidate server and owner-status socket and hold no lease pipe between attempts.
- Make waiting affect only pre-dispatch lease acquisition. It does not dispatch or replay a Chrome tool, release a lease, or kill or evict an owner. A timeout dispatches zero tools and forbids automatic retry.
- Keep MCP initialization and `tools/list` lease-free and responsive while tool calls wait.
- Add a three-client handoff test that verifies eventual completion after prior owners close, no overlapping fake-backend Chrome dispatch, and `list_pages` -> `select_page` -> target-tool order for every session.
- Document that cooperative waiting is bounded and is not FIFO or a fairness guarantee.

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

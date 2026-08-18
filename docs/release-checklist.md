# Release checklist

Complete every check on Windows before release.

## Package checks

- [ ] `npm-shrinkwrap.json` is present and matches `package.json`.
- [ ] `npm ci --ignore-scripts` completes.
- [ ] `npm test` completes.
- [ ] `npm audit` completes with an accepted result.
- [ ] CI uses Windows, Node 24, `npm ci`, `npm test`, and `npm audit`.

## Security checks

- [ ] The package has no HTTP, TCP, UDP, or WebSocket listener; only the documented local named pipes exist.
- [ ] The terminating gateway allowlist matches the reviewed Chrome DevTools tool set exactly.
- [ ] The gateway registers only one additional tool, `allow_remote_debugging`.
- [ ] Recovery is code-eligible only after this gateway’s first failed `list_pages`.
- [ ] Recovery accepts no arguments and does not use coordinates or general desktop input.
- [ ] Recovery validates the Google signature, Chrome metadata, current session, one dialog, exact title, and exact supported buttons.
- [ ] Indeterminate recovery states are explicit and have no automatic retry.
- [ ] An injected post-dispatch failure proves that one browser mutation is dispatched only once.
- [ ] Invalid `list_pages` arguments and tool-level errors do not enable recovery.
- [ ] A backend-generation change blocks mutation until fresh `list_pages` and `select_page` complete.
- [ ] Usage statistics, CrUX, and update checks are disabled in the fixed backend launch.
- [ ] Native class, modal owner, process start, and absence of web `Document` content are checked again before invocation.
- [ ] The lease releases only on gateway shutdown, after 10 minutes with an empty queue and no active tool, or after a complete authenticated idle-yield handshake from an explicit waiter.
- [ ] Idle release makes no Chrome call, clears selected-page and session state, and does not reset the recovery counter.
- [ ] Stdio end, close, and error plus front-transport close and fatal errors start one bounded shutdown path.
- [ ] The default gateway waits at most 750 ms plus the deterministic test tolerance, then returns authenticated `lease_busy`, `dispatched: false`, and `automatic_retry_allowed: false` without a Chrome dispatch.
- [ ] Only exact `chrome-devtools` or `chrome-devtools --lease-wait-ms N` is accepted. Canonical ASCII `N` is 750 through 300000. Missing, duplicate, extra, malformed, leading-zero, and out-of-range forms exit 2 with one bounded sanitized usage line before daemon access or MCP Server construction.
- [ ] Opt-in bounded cooperative waiting continues only for an authenticated owner. It closes every failed candidate server and owner-status socket, holds no lease pipe between attempts, and fails immediately for `held_unknown` or invalid status.
- [ ] Every acquisition has a new random lease instance ID. Yield and acknowledgement require the exact current gateway ID, lease ID, and token. Stale IDs cannot affect a later lease.
- [ ] Default gateways send authenticated status only. Only exact `--lease-wait-ms` clients can request yield.
- [ ] Active, queued, shutting-down, or quiet-grace owners refuse yield. An accepted yield blocks new tool dispatch on old state synchronously.
- [ ] The complete matching yield response arrives before the pipe becomes bindable. Release occurs only after the matching acknowledgement and response-socket close, including the bounded post-ACK close fallback for a stalled peer. A missing or invalid acknowledgement keeps the lease.
- [ ] Before ACK commit, MCP cancellation and the explicit `N` deadline stop status, yield, and polling waits and prevent later release. After ACK commit, a separate 1.5 second takeover can extend `N`, ignores acquisition cancellation, and releases the exact new lease before Chrome dispatch when the call was canceled.
- [ ] A cooperative-wait timeout dispatches zero tools and does not replay, release, kill, or evict an owner.
- [ ] With an authenticated owner and at least two waiting gateways, MCP initialization and `tools/list` complete within the normal bound without acquiring the lease.
- [ ] A three-client test proves that both waiters complete through authenticated idle handoff without prior owners closing, backend Chrome tool dispatch never overlaps, and each session enforces `list_pages`, `select_page`, then its target tool.
- [ ] Documentation calls the option bounded cooperative waiting and states that it is not FIFO and gives no fairness guarantee.
- [ ] Documentation states that the 250 ms quiet grace is only a race cushion, not a multi-call reservation. A yielded old owner must reacquire with fresh `list_pages` and `select_page` calls.
- [ ] Authenticated lease status is read-only, bypasses the Chrome queue, and returns only the approved owner facts, including the per-acquisition lease instance ID.
- [ ] `status.ps1` reports daemon health and `free`, `held`, or `held_unknown` lease state separately. It does not restart or stop a process.
- [ ] An absent daemon produces bounded `daemon_absent` output from gateway startup and `status.ps1`, without a raw pipe error or sensitive data.
- [ ] Read-only install preflight accepts a free lease and refuses known, legacy, invalid, or potentially reacquirable gateway ownership.
- [ ] A refused preflight makes no target change and does not kill, reap, evict, release, stop, or restart anything.
- [ ] Preflight instructions require the owning client session to finish or close before the operator waits for lease release and runs the check again.
- [ ] Documentation says that browser content is untrusted and this is not a browser sandbox.
- [ ] Documentation recommends a separate Chrome profile without sensitive accounts.
- [ ] Documentation says that a mutating timeout is indeterminate and must not be replayed.
- [ ] Documentation says that no defense exists against same-user malware or a local administrator.

## Install and removal checks

- [ ] The installer completes as staged installation with rollback on detected failure.
- [ ] The managed Codex configuration is unchanged and contains no lease-wait option.
- [ ] The installer runs the lease and gateway preflight before its first target write.
- [ ] Installer-owned configuration and the managed install root have expected ownership and access controls.
- [ ] The authenticated package-local daemon IPC is inspected with doctor before normal use.
- [ ] Doctor reports daemon status and no network listener mode.
- [ ] Doctor reports no legacy direct `npx chrome-devtools-mcp` process.
- [ ] A test with two tasks proves that `select_page` and a later mutation cannot interleave.
- [ ] A Chrome page that imitates the dialog strings is rejected without input.
- [ ] A UI Automation error after dispatch never causes a second invocation.
- [ ] The uninstaller removes only owned configuration and the owned scheduled task.
- [ ] The uninstaller does not remove Chrome, Chrome profiles, unrelated configuration, or previously granted Chrome remote-debugging permission.

## Release notes

- [ ] The README names the deliberate differences from the original issue comment.
- [ ] The README states that the package is not affiliated with Google, OpenAI, or the Chrome DevTools MCP maintainers.
- [ ] The release note lists new limits, migration needs, and rollback steps.
- [ ] CI produces a CycloneDX SBOM artifact.
- [ ] The release tag and published checksums are signed through the selected release process.

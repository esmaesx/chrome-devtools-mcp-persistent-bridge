# Chrome DevTools MCP Persistent Bridge

A Windows-only package that keeps one pinned Chrome DevTools MCP backend alive for Codex tasks. Codex connects through stdio. The package opens no HTTP, TCP, UDP, or WebSocket control endpoint.

> [!WARNING]
> This is not a browser sandbox. The allowed DevTools tools can read or change all exposed Chrome tabs. Use a separate Chrome profile without sensitive accounts, payment data, password-manager access, or unrelated sessions.

## Important change from the original issue comment

This package implements the goal in [ChromeDevTools/chrome-devtools-mcp issue #825, comment 4965356923](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825#issuecomment-4965356923), but it intentionally changes the recovery and transport design.

| Area | This package | Why it differs |
| --- | --- | --- |
| Client transport | Per-task stdio gateway; no HTTP/TCP control listener | An unauthenticated loopback port is not an authorization boundary. |
| Persistent backend | Small package-local named-pipe daemon and pinned Chrome DevTools MCP | A direct owner avoids one new Chrome connection per task and avoids middleware replay of failed mutations. |
| Local-host trust | Single-trust-user Windows host; the pipe token is not mutual client/server authentication | A different untrusted local account can pre-bind an enumerable pipe name, deny service, or impersonate the daemon long enough to receive the bearer token. Do not use this package on a shared host with untrusted local accounts. |
| Recovery tools | One gateway tool: `allow_remote_debugging` | General computer-use, screenshots, and coordinate clicks can act on the wrong application. |
| Recovery eligibility | Code-enforced only after the first valid, empty-argument `list_pages` was dispatched and failed | Agent instructions and a tool-level validation error are not a security boundary. |
| Dialog checks | Signed Google Chrome path, same session and process start, native modal ownership, native UI tree, exact English title, warning text, and controls | A title or screenshot alone can be spoofed. |
| Input action | One UI Automation invocation; no fallback click and no second invocation | A UI error can occur after the button already acted. |
| Result | Reports dialog state, including indeterminate states; a later `list_pages` is the end-to-end check | A closed dialog does not prove approval succeeded. |
| Shared page state | One cross-process lease with safe idle release; fresh `list_pages` and `select_page` are enforced after each acquisition | A per-call lock permits select-and-act races between tasks. |
| Lease contention | Configured Codex gateways fail fast after 750 ms; an explicit CLI-only option permits bounded cooperative waiting | A CLI workflow can wait for a live owner without changing the managed Codex gateway or replaying a tool. |
| Timeouts | 15 seconds for discovery, 60 seconds for normal calls, and 120 seconds for long calls | One short global timeout can leave a mutation running after the caller times out. |
| Retry | No automatic replay of a mutating call | A timed-out mutation can have completed. |
| Privacy defaults | Usage statistics, CrUX lookups, and update checks are disabled | A local bridge must not send diagnostic or inspected-URL data by default. |
| Dependencies | Exact root pins plus `npm-shrinkwrap.json`; no runtime `npx` download | This reduces dependency drift and prevents package downloads at logon. |
| Startup | Normal interactive user, limited run level, fixed paths, one scheduled-task instance | The watchdog must not run elevated or resolve an attacker-controlled executable. |
| Configuration | Owned blocks, backups, compare-before-write checks, and rollback on detected install failure | Whole-file replacement can destroy unrelated user configuration. |

## Requirements

- Windows 10 or later on x64.
- Windows PowerShell 5.1.
- Node.js 24.x and npm 11.9.0.
- Official Google Chrome with a valid Google signature.
- Codex with local stdio MCP support.

## Install

Clone this repository, review the scripts, and run:

```powershell
npm ci --ignore-scripts
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-install.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -InstallAgentGuidance
```

The read-only preflight returns one JSON object. `status: ready` and `cause: lease_free` permit installation. An authenticated held lease returns `lease_held`. An old or invalid lease owner that cannot return authenticated status returns `lease_held_unknown`. A live gateway that released its idle lease returns `live_gateway_present` because it can acquire the lease again. The installer runs the same preflight before its first target write.

If preflight is blocked, finish or close every client session that uses this bridge. Wait for the lease to become free. Run the preflight again, and then run the installer again. Do not kill, reap, evict, or force-release a gateway.

`-InstallAgentGuidance` is an explicit opt-in. It previews and adds a managed block to the Codex `AGENTS.md`. The gateway enforces the safety-critical lock, discovery order, recovery eligibility, timeouts, and tool allowlist in code. The agent block is supplementary guidance.

If Codex already defines `chrome-devtools` or the old `chrome-debugging-recovery` server, the installer stops without changing it. Review that configuration, then use `-ReplaceExistingChromeMcp` to back up and replace only those sections.

The install is a **staged installation with rollback on detected failure**. It builds and validates the complete candidate payload, including the pinned dependencies, in a unique same-volume staging directory before it stops the old owned task or daemon. During commit, it moves the old payload to a transaction backup and moves the staged payload into place. If a later step fails, it stops the new owned task or daemon, preserves the failed payload for diagnosis, restores the old payload, state, managed files, and task XML, then restarts an old running task. It is not one atomic Windows transaction. Backups are stored under the owner-only install root.

After installation, restart Codex. Old conversations can use the bridge in a new run. Old runs can keep direct `npx chrome-devtools-mcp` processes or a replaced bridge prototype alive. Run doctor and close or explicitly stop those legacy MCP processes before you rely on one persistent backend.

```powershell
npm run doctor
```

## Normal operation

One Codex task owns the bridge from its first Chrome tool call until its MCP gateway exits or the lease is safely idle for 10 minutes. Safe idle means that no tool is active and the gateway tool queue is empty. Idle release changes only gateway state. It does not call Chrome, close a tab, or change a page. It clears saved page and session state. The next lease acquisition must start with `list_pages` and `select_page`.

A normal gateway uses the exact `chrome-devtools` argument and waits for at most 750 ms. It then gets `lease_busy` with limited authenticated owner facts, or `held_unknown` for an old or invalid owner. The result has `dispatched: false` and `automatic_retry_allowed: false`. The managed Codex configuration remains on this fail-fast form.

A Teal CLI gateway process can opt in to bounded cooperative waiting with the exact form below. `N` must use canonical ASCII decimal digits, with no leading zero, and must be from 750 through 300000 milliseconds inclusive.

```powershell
node runtime\stdio-proxy.mjs chrome-devtools --lease-wait-ms N
```

The gateway accepts only the default form or that exact three-argument form. A missing value, duplicate flag, extra argument, malformed number, leading zero, or out-of-range value produces one fixed usage line and exit code 2 before daemon access or MCP server construction. The wait changes only lease acquisition before dispatch. While an authenticated owner holds the lease, the candidate closes each failed pipe server and owner-status socket before another bounded attempt. It holds no lease pipe between attempts. It makes no Chrome call, does not replay a tool, and does not release, kill, or evict the owner. An old, invalid, or unauthenticated owner fails immediately as `held_unknown`. A timeout dispatches no tool.

This is bounded cooperative waiting, not a FIFO queue. Competing gateways can acquire in any order. Each successful gateway still must use `list_pages`, then `select_page`, before its target tool. MCP initialization and `tools/list` do not acquire the browser lease and remain available while a tool call waits.

If the persistent daemon is absent, gateway startup writes one bounded, sanitized JSON diagnostic with `status: startup_failed` and `cause: daemon_absent`. `runtime\status.ps1` always writes one schema-version 2 JSON object. It preserves daemon absence as `daemon.status: absent` and `daemon.cause: daemon_absent`. It uses fixed status and cause values for missing or invalid install state and missing Node or daemon files. It exits 0 for a healthy daemon, 3 for a daemon health fault, and 4 for an install-state or runtime fault. It does not include the bearer token, a command line, page data, or a raw local error.

The gateway requires this order:

1. `list_pages`
2. `select_page`
3. Other Chrome tools

Browser content is untrusted and can attempt agent prompt injection. Verify the selected URL and page before each important mutation. A mutating timeout or closed transport is indeterminate. The call can have completed. Inspect state and do not replay that mutation automatically.

## Permission recovery

The same `chrome-devtools` gateway exposes `allow_remote_debugging`. It is blocked unless this gateway’s first Chrome call was a valid zero-argument `list_pages`, the daemon dispatched it to the backend, and that call failed. A schema error or ordinary tool result does not enable recovery. The recovery action can be consumed once.

The helper requires all of these conditions:

- The configured Chrome executable has a valid Google signature and expected product metadata.
- The process path has no reparse point and matches the installed path.
- The dialog belongs to the same Windows session and the same Chrome process start.
- There is one native, owned `Chrome_WidgetWin_1` modal window titled exactly `Allow remote debugging?`.
- The native UI tree contains no web document and has the exact English warning text, one enabled `Allow`, one `Cancel`, and one `Turn off in settings` control.
- The identity is unchanged immediately before invocation.

The helper invokes `Allow` once. It has no target, coordinate, screenshot, script, clipboard, keyboard, or general desktop input. It never invokes a second time.

Possible results include `invoked_dialog_closed`, `invoke_error_dialog_closed_indeterminate`, `dialog_remained`, `dialog_changed_or_replaced`, `not_found`, and `blocked_*`. A closed dialog is not called a successful approval. One read-only `list_pages` retry can test the end-to-end result. Do not retry the input action.

## Security model

- **Terminating gateway:** Codex sees only the reviewed 29 Chrome tools plus the one gated recovery tool. Backend resources, prompts, sampling, roots, elicitation, logging requests, and server instructions are not relayed.
- **No network control endpoint:** The package creates no HTTP/TCP/UDP/WebSocket listener.
- **Actual daemon IPC:** A package-local daemon uses a bearer-token, install-specific Windows named pipe to keep the backend alive. Doctor checks its exact process and network-listener state. The token authenticates a request to the real daemon, but the gateway does not cryptographically authenticate the pipe server. The pipe namespace is enumerable and first-creator-wins. Do not use the package on a shared host with another untrusted local account.
- **Generation-safe calls:** The daemon never replays a dispatched tool call. Each backend start changes its generation. A stale generation blocks the call and forces a new `list_pages` and `select_page` before a mutation.
- **Lease-scoped ownership:** The gateway atomically binds a second install-specific named pipe until its process exits or reaches 10 minutes of safe idle time. Idle release clears gateway page state only. The authenticated status operation reports only the owner PID, parent PID, gateway instance ID, acquisition time, last activity, in-flight state, and queue depth. It cannot release or change the lease. An explicit CLI wait only repeats closed acquisition attempts against an authenticated live owner; it does not reserve a FIFO position.
- **Outbound privacy:** Chrome DevTools MCP starts with usage statistics and CrUX disabled, and its update-check environment flag is disabled. Browser network traffic requested by a DevTools tool is still possible.
- **Exact dependency graph:** `npm-shrinkwrap.json` controls `npm ci`. Logon startup uses only package-local files and performs no package download.
- **Least privilege:** The task runs as the current interactive user with `Limited` run level and fixed absolute paths.
- **Narrow audit:** Recovery writes rotated metadata to an owner-only directory. It stores no screenshot, page content, or browser history.
- **Ownership-exact removal:** The uninstaller refuses edited managed blocks or a changed scheduled task and leaves them for manual review.

See [architecture](docs/architecture.md) and [threat model](docs/threat-model.md).

## Limits

- Windows x64, Node 24, PowerShell 5.1, official Google Chrome, and the exact supported English dialog are the tested scope.
- Chrome changes, localization, enterprise policy, remote sessions, endpoint security software, or a different native UI shape can make recovery fail closed.
- The package cannot isolate independent Codex tasks inside one Chrome profile. It permits only one active lease at a time.
- Bounded cooperative waiting is not FIFO and gives no fairness or acquisition-order guarantee.
- The bridge cannot protect against another untrusted local account, malware running as the same user, a local administrator, a compromised MCP client, or a person who controls the desktop. A different local account can cause denial of service or pre-bind a predictable pipe name and capture the bearer token. Use a single-trust-user Windows host.
- The bridge does not make authenticated tabs safe for untrusted automation.
- Uninstalling the bridge does not revoke a Chrome remote-debugging permission. Use Chrome settings and restart Chrome if you must revoke that state.

## Verify and uninstall

```powershell
npm test
npm audit
npm run doctor
```

Remove the owned configuration and scheduled task:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

Add `-RemoveInstalledFiles` only for the default install location. A custom install directory is preserved for manual review. The uninstaller refuses an install root, ancestor, or descendant reparse point before it enumerates or removes files. See [operations](docs/operations.md) and the [release checklist](docs/release-checklist.md).

## Relationship and affiliation

This independent project is not affiliated with, endorsed by, or supported by Google, OpenAI, Codex, or the Chrome DevTools MCP maintainers.

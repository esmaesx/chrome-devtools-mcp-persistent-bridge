# Architecture

## Process and transport model

Codex starts `runtime/stdio-proxy.mjs` as one stdio MCP server. This process is a terminating gateway, not a transparent JSON-RPC relay. It exposes only:

- The exact reviewed 29-tool manifest from pinned `chrome-devtools-mcp` 1.7.0.
- One local tool named `allow_remote_debugging`.

The gateway does not expose backend resources, prompts, sampling, roots, elicitation, or logging capabilities.

The gateway talks to a small package-local daemon through a token-authenticated, install-specific Windows named pipe. The daemon directly owns one pinned Chrome DevTools MCP process. It starts that process with `--autoConnect --no-usage-statistics --no-performance-crux` and sets `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`. No package component creates an HTTP, TCP, UDP, or WebSocket control listener.

```text
Codex task
  -> stdio
terminating gateway
  -> authenticated local named-pipe request
package-local persistent daemon
  -> stdio
pinned Chrome DevTools MCP
  -> Chrome remote-debugging connection
```

The daemon pipe accepts only the small `status`, `listTools`, `callTool`, and `stop` protocol with the installed random bearer token. This is one-way request authentication. The gateway does not authenticate the pipe server. Windows pipe names are enumerable and first-creator-wins, so another untrusted local account can pre-bind the name, deny service, or impersonate the daemon and receive the token. This project supports only a single-trust-user Windows host. It is also not a defense against the same Windows user or an administrator. The install root and audit directory use an owner-and-SYSTEM ACL. Doctor checks the daemon process identity and network-listener state after connection, but this does not make the initial pipe connection mutually authenticated.

## Lease-scoped ownership

The first Chrome or eligible recovery call atomically binds an install-specific local Windows named pipe. The gateway holds that pipe until its MCP process exits, the lease is safely idle for 10 minutes, or an explicit waiter completes the authenticated idle-yield handshake. Safe idle means that no tool is active and the gateway queue is empty. Lease release changes gateway state only. It makes no Chrome, tab, page, or backend call. It clears selected-page and backend-session state, sets the page state to `need_list`, and does not reset the one-use recovery counter.

The gateway also releases the lease when stdio ends or closes, the front transport closes, a fatal error occurs, or the process receives a termination signal. Shutdown is idempotent. It lets the active call finish for a bounded time. It does not dispatch a queued call after shutdown starts.

The lease pipe accepts a bearer-token-authenticated, read-only `status` request. The exact response contains only the gateway PID, parent PID, gateway instance ID, random per-acquisition lease instance ID, acquisition time, last activity time, in-flight state, and queue depth. Status does not use the Chrome tool queue and cannot call Chrome, release a lease, or change gateway state.

The default gateway tries to acquire the lease for at most 750 ms. It then returns `lease_busy` with the limited owner facts and `dispatched: false`, or `held_unknown` when an old or invalid owner does not return valid authenticated status. It does not kill, evict, or reap the owner. Windows removes the pipe binding when its gateway exits. The installer keeps the managed Codex configuration on this default form.

A CLI gateway can use exact `chrome-devtools --lease-wait-ms N` arguments to request a bound from 750 through 300000 ms. The parser accepts only canonical ASCII decimal digits without leading zeros. It rejects all other shapes with one fixed usage error and exit code 2 before daemon access, lease binding, or MCP server construction.

The opt-in bound changes only `acquireTaskLease` before tool dispatch. On a pipe collision, the candidate closes its failed server and probes the owner through a short-lived status socket. After valid authenticated status, an explicit waiter sends a distinct authenticated `yield` request bound to both reported instance IDs. Default gateways never send this request. `held_unknown` or invalid status fails immediately. Each status socket closes, and the waiter holds no lease pipe between attempts.

The owner accepts a yield only for its exact current token and IDs, with no active or queued tool, no shutdown, and after a short monotonic quiet grace from the last tool activity. It sets `yieldPending` before it sends the response, so no new tool can dispatch on old page state. It writes one bounded matching JSON line, then waits for the waiter to read it and send an exact acknowledgement. The response socket closes before the normal state-reset release starts. After a valid acknowledgement, an owner-side bounded destroy fallback closes a stalled peer and completes the committed release. If acknowledgement does not arrive within its short bound, the owner clears `yieldPending` and keeps the lease. Every acquisition gets a new lease instance ID, so a delayed request cannot release a later lease.

The waiter uses the explicit `N` acquisition deadline and the MCP request abort signal before it commits the acknowledgement. Cancellation or timeout before that commit closes the current socket and cannot release the owner later. Once the acknowledgement is queued, the handoff is irrevocable because the owner can receive it and release. The waiter clears the original timer, detaches acquisition cancellation, and uses a separate 1.5 second bounded non-cancelable commit deadline to take the released lease. This commit window can extend the total call time beyond `N` by up to 1.5 seconds. If the MCP call was canceled, it immediately releases only the new matching lease and dispatches no Chrome tool. Waiting makes no backend or Chrome call. It does not replay the pending tool, release an active or queued owner, or terminate a process. A timeout before acknowledgement returns a non-dispatched busy result.

This mechanism is bounded cooperative waiting, not a FIFO queue. Competing waiters can acquire in any order. MCP `initialize` and `tools/list` use no lease and remain responsive while a tool call waits. After acquisition, every gateway independently enforces `list_pages`, then `select_page`, before a target tool. The 250 ms quiet grace is only a short race cushion. It does not reserve a logical `list_pages` -> `select_page` -> target sequence across model round trips. An explicit waiter can yield between calls after the grace. Yield resets the old owner page state, so its next target call returns `blocked_discovery_required`; it can reacquire and continue only after fresh discovery and selection.

The update preflight probes this lease without binding, releasing, or changing it. It also checks for a live gateway process that can reacquire an idle-released lease. A known owner, an old or invalid owner, or unknown gateway presence blocks an in-place update before the installer writes to its target. The operator must finish or close the owning client session and run preflight again.

After each lease acquisition, the gateway enforces `list_pages`, then `select_page`, before another Chrome tool. The lease does not stop a person or a separate browser tool from changing Chrome.

## Tool execution and timeouts

Chrome tool calls are serialized in both the gateway and daemon. Authenticated daemon status and cached manifest reads bypass the Chrome queue. They do not call Chrome or change browser state. This lets a new gateway initialize, list tools, and inspect authenticated lease owner facts while another gateway has a long Chrome call in flight. Discovery has a 15-second internal budget, normal tools have 60 seconds, and long operations have 120 seconds. The daemon does not replay a dispatched call. Each backend start increments a generation. The gateway supplies the expected generation, so a backend restart blocks later calls and forces fresh discovery and selection. A reconnect must expose the same reviewed names, descriptions, and input schemas or the gateway fails closed.

After an authenticated stop request is accepted, the daemon rejects each later Chrome tool with `shutting_down` and `dispatched: false`. This gate applies to calls that are already behind stop in the queue and to calls that arrive after stop changes the daemon state. A later `list_pages` cannot reconnect the backend. Read-only status and cached manifest requests remain control operations and do not call Chrome.

Gateway startup gives the cached daemon manifest request a 5-second bound. The cached read does not wait behind a Chrome call. An absent daemon produces one sanitized machine-readable `daemon_absent` cause. The diagnostic does not contain the daemon token, command lines, page data, or the raw named-pipe error.

A timed-out read operation returns a read failure. A timed-out mutation returns `indeterminate_mutating_call` and states that it can have completed. The gateway does not replay it.

## Recovery path

Recovery is inside the same gateway and shares the same lease. It is eligible only when that gateway’s first Chrome call was a valid empty-argument `list_pages`, the daemon dispatched it, and it failed. A local argument rejection or an MCP tool result with `isError` does not enable recovery. Eligibility is one-use, and idle lease release does not reset it.

`allow-remote-debugging.ps1` validates the recorded Chrome path and signature, process session and start time, top-level native class and owner, UI Automation window type, absence of a web `Document` descendant, and the exact supported English warning text and controls. It rebuilds and rechecks that UI tree immediately before one UI Automation invocation.

The result describes what was observed. `invoked_dialog_closed` means that the verified dialog closed after invocation. It does not mean that approval succeeded. A UI Automation error plus dialog closure is `invoke_error_dialog_closed_indeterminate`. The helper never invokes twice.

## Managed lifecycle

Installation is staged and uses backups, hashes, owned marker blocks, compare-before-write checks, and rollback when a detected step fails. It is not one atomic Windows transaction. `AGENTS.md` guidance is optional and needs `-InstallAgentGuidance`.

The scheduled task runs only at interactive user logon with limited run level, a fixed action, and one-instance behavior. It starts only package-local files. It does not approve a dialog.

Uninstall validates exact marker hashes and scheduled-task identity. If a managed block or task changed, uninstall preserves it for manual review.

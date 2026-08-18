# Threat model

## Assets

- The signed Chrome executable selected during installation.
- Chrome profiles, authenticated sessions, page content, downloads, and files reachable from browser tools.
- Managed MCP configuration, the local lease, and recovery audit records.

## Trust boundary

The local MCP client and its user are trusted to request the permitted DevTools actions. Chrome and Windows are trusted to provide process, signature, and UI Automation data. The package does not trust arbitrary MCP request names, arbitrary coordinates, an arbitrary Chrome process, a window title alone, or a network client.

## Threats and controls

| Threat | Control |
| --- | --- |
| A remote client reaches a browser-control service. | The package exposes stdio only. It creates no HTTP/TCP listener or network endpoint. |
| A caller asks for an unreviewed tool or backend capability. | A terminating gateway registers only 29 reviewed Chrome tools plus one gated recovery tool. It does not relay other MCP capabilities. |
| A recovery action clicks an unrelated window. | It validates installed path, Google signature, process start, current session, native class and owner, native UI ancestry, exact title, and exact supported controls. It accepts no coordinates. |
| Web content imitates the dialog. | Recovery rejects a matching window that has a web `Document` descendant or lacks the expected native modal ownership. Identity is checked again before invocation. |
| A malformed or duplicate dialog is acted on. | Zero or multiple candidates, missing controls, and unexpected UI Automation identity all block the action. |
| A repeated action changes state twice. | Recovery eligibility is code-enforced, one-use, and tied to the gateway’s first valid, dispatched, failed `list_pages`. The daemon never replays a dispatched tool call. |
| Two tasks act on an old selected page. | A cross-process exclusive lease means one Codex task controls the bridge at a time. Safe idle release clears selected-page state. Each acquisition requires fresh page discovery and selection. |
| A dead parent leaves a live gateway and lease. | The gateway watches stdio end, close, and error plus front-transport close and fatal process errors. Shutdown is idempotent, waits for an active call for a bounded time, and does not dispatch queued calls. |
| A status check changes browser or lease state. | The authenticated lease status path is separate from the Chrome queue. It returns limited owner facts and cannot release or mutate the lease. Only an explicit waiter can send the distinct ID-bound yield request. |
| An explicit waiter takes the lease between `list_pages`, `select_page`, and a target tool. | This is permitted after the 250 ms race cushion; there is no multi-call reservation. Acceptance blocks old-state dispatch. Yield resets page state, so the old owner gets `blocked_discovery_required` and must reacquire with fresh discovery and selection. |
| A canceled, timed-out, unauthenticated, or stale waiter causes an orphan release. | Before ACK commit, the explicit `N` deadline and MCP abort prevent release. After ACK commit, a separate 1.5 second non-cancelable takeover completes the irrevocable handoff and a canceled call releases only its exact new lease before Chrome dispatch. Token and exact gateway and lease IDs bind every message. Missing or invalid ACK keeps the owner lease. |
| An old or invalid owner holds the lease pipe. | Acquisition fails in less than one second with `held_unknown`. The bridge does not kill, evict, or reap the owner. |
| An update overwrites files used by a live or legacy gateway. | A read-only preflight checks the lease and exact gateway process path before the first target write. Held, unknown, and potentially reacquirable states block the update and require the owning client session to end. |
| A raw daemon startup error leaks local data or cannot be classified. | Gateway startup and status map bounded connection failures to fixed cause values such as `daemon_absent`. They do not return the token, command line, page data, or raw pipe error. |
| A page or tab supplies hostile content. | Browser content is untrusted. This is not a browser sandbox: allowed tools can read or change all exposed tabs. Use a separate Chrome profile without sensitive accounts. |
| A network failure hides a completed mutation. | A mutating timeout or transport closure is indeterminate. The caller must inspect state and must not replay the mutation. |
| A backend restarts after page selection. | Every backend start changes a generation. A call with an old generation is rejected before dispatch and fresh page discovery and selection are required. |
| A same-user process reaches a local service. | Daemon IPC uses an install-specific pipe and token, but it is not a barrier against the same user. The managed install root is owner-only; use doctor to inspect daemon state before use. |
| A different untrusted local account can enumerate and pre-bind a named pipe. | This risk is outside the supported boundary. The gateway does not authenticate the pipe server. An attacker can deny service or impersonate the daemon and receive the bearer token. Use only a single-trust-user Windows host. |
| Diagnostic data leaves the machine by default. | Usage statistics, CrUX requests, and update checks are disabled in the fixed backend launch. Browser traffic requested by a permitted tool remains possible. |
| Dependency drift changes tool behavior. | Versions are pinned, `npm-shrinkwrap.json` fixes the install graph, and release verification uses `npm ci` and `npm audit`. |
| Logs leak sensitive browser content. | The recovery audit contains result metadata only; it does not store screenshots or dialog text. |
| Removal deletes user data or another MCP server. | Managed blocks and the scheduled task have recorded identity and hashes. Changed objects are preserved for manual review. |

## Non-goals

This package does not secure Chrome against another untrusted local account, a malicious local administrator, malware running as the same user, a compromised trusted MCP client, or a person who directly controls the desktop. Windows named-pipe names are enumerable and first-creator-wins. The token is a bearer credential, not mutual client/server authentication. It does not provide remote access, general desktop automation, coordinate clicking, a browser sandbox, or confirmation of a business-level browser mutation. It is not affiliated with Google, OpenAI, or the Chrome DevTools MCP maintainers.

## Residual risk

A permitted DevTools tool can still affect authenticated pages. Use a dedicated Chrome profile where practical, inspect the selected page before a mutation, and treat navigation or submission results as state that needs verification. The recovery dialog shape is intentionally narrow; Chrome UI changes cause an availability failure rather than a broader action.

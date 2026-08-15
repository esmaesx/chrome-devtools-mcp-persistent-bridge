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

## Task-lifetime lease

The first Chrome or recovery call atomically binds an install-specific local Windows named pipe. The gateway holds that pipe until its MCP process exits. Windows removes the binding when the process exits, so stale-file deletion cannot race with a new owner. The gateway does not release the lease after a tool call and does not expire a live owner by age.

The lease pipe accepts no commands and immediately closes any connection. It is an ownership primitive, not an authentication boundary. Another process under the same Windows user, or another local account with pipe access, can deny service by binding it first.

Another task waits for up to 30 seconds, then returns a busy error. It cannot interleave `select_page` and a later mutation with the owner task. Windows removes the lease-pipe binding when the owning gateway exits.

After lease acquisition, the gateway enforces `list_pages`, then `select_page`, before another Chrome tool. The lease does not stop a person or a separate browser tool from changing Chrome.

## Tool execution and timeouts

Calls are serialized in both the gateway and daemon. Discovery has a 15-second internal budget, normal tools have 60 seconds, and long operations have 120 seconds. The daemon does not replay a dispatched call. Each backend start increments a generation. The gateway supplies the expected generation, so a backend restart blocks later calls and forces fresh discovery and selection. A reconnect must expose the same reviewed names, descriptions, and input schemas or the gateway fails closed.

A timed-out read operation returns a read failure. A timed-out mutation returns `indeterminate_mutating_call` and states that it can have completed. The gateway does not replay it.

## Recovery path

Recovery is inside the same gateway and shares the same task-lifetime lease. It is eligible only when that gateway’s first Chrome call was a valid empty-argument `list_pages`, the daemon dispatched it, and it failed. A local argument rejection or an MCP tool result with `isError` does not enable recovery. Eligibility is one-use.

`allow-remote-debugging.ps1` validates the recorded Chrome path and signature, process session and start time, top-level native class and owner, UI Automation window type, absence of a web `Document` descendant, and the exact supported English warning text and controls. It rebuilds and rechecks that UI tree immediately before one UI Automation invocation.

The result describes what was observed. `invoked_dialog_closed` means that the verified dialog closed after invocation. It does not mean that approval succeeded. A UI Automation error plus dialog closure is `invoke_error_dialog_closed_indeterminate`. The helper never invokes twice.

## Managed lifecycle

Installation is staged and uses backups, hashes, owned marker blocks, compare-before-write checks, and rollback when a detected step fails. It is not one atomic Windows transaction. `AGENTS.md` guidance is optional and needs `-InstallAgentGuidance`.

The scheduled task runs only at interactive user logon with limited run level, a fixed action, and one-instance behavior. It starts only package-local files. It does not approve a dialog.

Uninstall validates exact marker hashes and scheduled-task identity. If a managed block or task changed, uninstall preserves it for manual review.

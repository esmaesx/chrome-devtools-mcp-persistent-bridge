# macOS setup

This distribution supports Windows named pipes and macOS Unix domain sockets. The macOS runtime was tested locally on Apple Silicon with Node 26.5.0 using the real daemon and proxy, a synthetic MCP backend, and a temporary Chromium profile for Bulk Files upload tests. The authenticated bridge smoke test also passed locally on Node 24. macOS CI is not yet enabled.

## Install

Use an owner-controlled checkout of this repository with Node 24 or 26:

```sh
npm ci --ignore-scripts
npm run setup:macos
```

Setup creates an owner-only `install-state.json` without printing its token. It does not edit Codex configuration, start Chrome, or install a background service. Existing state is preserved. Keep the checkout in the same location after setup.

Start the daemon in a terminal and keep it running:

```sh
node runtime/daemon.mjs
```

In another terminal:

```sh
node runtime/daemon.mjs --status
node runtime/daemon.mjs --lease-status
```

The proxy is an MCP stdio command: use the absolute Node executable printed by setup, with arguments `["<absolute-checkout>/runtime/stdio-proxy.mjs", "chrome-devtools"]`. Use only the intended Chrome session. If Chrome needs remote-debugging permission, enable the browser's supported remote-debugging setting and approve its prompt yourself. The macOS recovery tool returns `manual_permission_required`; it does not click dialogs or invoke PowerShell.

Stop the daemon only after active clients have finished:

```sh
node runtime/daemon.mjs --stop
```

## Local transport

The daemon and lease sockets live under `/private/tmp/sahar-tacit-<uid>/`, with an install-root hash in each filename. That directory must be owned by the current user, have mode `0700`, and not be a symlink. State files must be owner-only regular files. Requests still require the existing bearer token and lease protocol. No TCP listener is added.

A crashed process may leave a socket file. The bridge refuses to remove an existing socket automatically. Diagnose the exact owning process before removing a stale socket. Do not delete the whole socket directory while another installation is active.

## Bulk Files on macOS

Use the matching `sahar-tacit/teal-eval-bulk-files` checkout and its Node CLI; the PowerShell wrapper remains the Windows entry point. Pass `--upload-mode api` explicitly for upload planning, list, and verify. Apply inherits the saved plan mode.

```sh
node '<teal-root>/extension/teal-eval-bulk-cli.mjs' --persistent-bridge '<bridge-root>/runtime/stdio-proxy.mjs' --issue RPY-123 status
node '<teal-root>/extension/teal-eval-bulk-cli.mjs' --persistent-bridge '<bridge-root>/runtime/stdio-proxy.mjs' --issue RPY-123 --upload-mode api list
```

Replace placeholders with absolute paths and the selected issue. The usual plan/apply authorization and verification rules still apply. These commands do not select a browser on your behalf.

## Checks

```sh
npm run test:macos
```

The smoke test uses an isolated installation and fake Chrome backend. It checks authentication, state permissions, MCP calls, and manual-only permission recovery. A signed-in production Chrome session and a live Teal upload were not used for this validation.

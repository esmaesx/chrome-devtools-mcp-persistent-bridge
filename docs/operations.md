# Operations

## Install and inspect

Install only from a reviewed package directory:

```powershell
npm ci --ignore-scripts
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-install.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -InstallAgentGuidance
npm run doctor
```

Keep the resulting configuration managed. Installation builds and validates the full candidate payload in a unique same-volume staging directory before it stops the old owned task or daemon. A later failure preserves the failed candidate and restores the old payload, state, managed files, task XML, and old running task. Do not replace its stdio commands with a URL, a TCP proxy, or listener flags. Do not edit the saved Chrome path to bypass validation.

A package-local daemon keeps one Chrome DevTools MCP process alive. Per-task stdio gateways use bearer-token local named-pipe requests. This is not mutual authentication. It is not a security boundary against same-user processes or another untrusted local account that can pre-bind an enumerable pipe name. Use only a single-trust-user Windows host. The installer makes the managed install root owner-only. Run doctor to inspect daemon status and the managed configuration before normal use.

## Per-task workflow

1. Start the stdio gateway through the managed MCP configuration.
2. Call `list_pages` and select the intended page for this task. The gateway enforces this order. A backend-generation change or a safe idle lease release forces this sequence again. One Codex task controls the bridge until its MCP process exits or its queue and active-call count stay empty for 10 minutes.
3. Inspect state before and after a mutation. The local lease serializes bridge users, but it does not prove the page is unchanged by other software. Browser content is untrusted.
4. If the first `list_pages` fails and the DevTools permission dialog is shown, use `chrome-devtools.allow_remote_debugging` one time. The gateway blocks it for any other condition.
5. Treat `invoke_error_dialog_closed_indeterminate`, `dialog_remained`, `dialog_changed_or_replaced`, and `blocked_*` as non-success states. Use only one read-only `list_pages` confirmation where the result permits it. Do not replay the recovery action.

This bridge is not a browser sandbox. The allowed tools can read or change all exposed tabs. Use a separate Chrome profile without sensitive accounts, active payment methods, or unrelated authenticated services. A mutating timeout or transport closure is indeterminate. Do not replay the mutation automatically.

## Audit and diagnosis

Recovery attempts append JSON Lines records to `logs/recovery-audit.jsonl`. The log records timestamp, status, mutation state, process/window identifiers, and a short result detail. It is locally rotated. Treat it as operational metadata: restrict file access because process identifiers can still be useful to a local attacker.

`npm run doctor` is the first diagnostic check when supplied. It should report configuration and validation findings only. Do not work around a failed doctor result by adding a listener or by invoking generic desktop automation.

Run `runtime\status.ps1` for a read-only current-state check. It always writes one schema-version 2 JSON object. It exits 0 for a healthy daemon, 3 for a daemon health fault, and 4 for an install-state or runtime fault. Missing or invalid install state and missing Node or daemon files have fixed `daemon.status` and `daemon.cause` values. The output does not include a raw local error. It reports daemon health and lease state as separate objects. Lease state is `free`, `held`, or `held_unknown`. A held result contains only the gateway PID, parent PID, gateway instance ID, acquisition time, last activity time, in-flight state, and queue depth. Status does not enter the Chrome tool queue and does not change or release the lease. Do not classify a process as abandoned from process count alone.

If the daemon pipe is absent, status reports `daemon.status: absent` and `daemon.cause: daemon_absent`. Timeout, unreachable, and invalid-status failures have separate bounded cause values. Status does not copy a raw pipe error into its JSON output. The gateway uses the same `daemon_absent` cause in its one-line startup diagnostic.

Before a first install or update, run `scripts\preflight-install.ps1`. It is read-only and emits one JSON object. It refuses a known held lease, a legacy or invalid `held_unknown` lease, a live gateway with a free idle lease, or an unknown gateway process state. The installer runs this check again before its first target write. On refusal, finish or close the owning client sessions, wait for the lease to clear, run preflight again, and then run the installer again. Do not kill, reap, evict, or force-release a gateway.

## Update and rollback

Before an update, run:

```powershell
npm ci --ignore-scripts
npm test
npm audit
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-install.ps1
```

Re-run the installer after a reviewed update so it can reconcile managed configuration. To remove the package-managed integration, run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

The uninstaller must retain Chrome, Chrome profiles, other MCP servers, and unrelated user configuration. It refuses an install root, ancestor, or descendant reparse point before it recursively enumerates or removes files. It does not revoke Chrome remote-debugging permission that Chrome has already granted. If it reports an ownership mismatch, stop and review the recorded state instead of deleting files by hand.

## Incident response

If an unexpected action occurs, stop the MCP client, preserve the audit log and managed state, and record the selected page and time. Do not repeat an uncertain mutation. Remove the bridge through the uninstaller if containment is needed, then investigate the trusted client and local user account.

If doctor reports `no-legacy-direct-chrome-mcp` as failed, one or more old Codex runs still use a direct `npx chrome-devtools-mcp` process or a replaced bridge prototype. These processes bypass the persistent daemon and can cause repeated native approval dialogs. Finish the old run or stop only the verified legacy MCP process tree. Do not stop Chrome or the persistent daemon as a first response.

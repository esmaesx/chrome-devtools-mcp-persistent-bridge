# Contributing

## Scope

This is a Windows-only local bridge. Keep its security limits narrow. Do not add an HTTP, TCP, UDP, or WebSocket listener, general desktop control, coordinate clicks, arbitrary PowerShell input, or an automatic retry for an uncertain mutation.

The bridge is not a browser sandbox. Browser content is untrusted, and permitted DevTools tools can read or change all exposed tabs. Test with a separate Chrome profile that has no sensitive accounts.

## Change rules

- Keep the terminating gateway tool allowlist exact and small.
- Keep one no-argument recovery tool inside the same task-locked gateway unless a security review approves a new scope.
- Preserve code-enforced one-use recovery eligibility after only the first failed `list_pages`.
- Require signed Chrome, exact dialog identity, one dialog candidate, and exact supported controls before a recovery action.
- Treat mutating timeouts and transport closures as indeterminate. Do not add replay logic for them.
- Preserve the cross-process lease. One Codex task controls the bridge at a time.
- Preserve the no-replay daemon protocol, backend-generation checks, fixed privacy flags, owner-only managed files, and doctor inspection.
- Keep installer changes as staged installation with rollback on detected failure. Do not delete user configuration outside owned state.

## Local checks

Run these checks before a review:

```powershell
npm ci --ignore-scripts
npm test
npm audit
```

When you change installer, uninstaller, or doctor behavior, test only in an isolated Windows user profile or test environment. Do not test recovery against an unrelated desktop dialog.

## Disclosure

Report a suspected security issue privately through the channel defined in `SECURITY.md`. Do not publish exploit steps or sensitive Chrome profile data in an issue.

This independent project is not affiliated with Google, OpenAI, or the Chrome DevTools MCP maintainers.

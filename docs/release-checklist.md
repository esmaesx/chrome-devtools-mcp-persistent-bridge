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
- [ ] The task-lifetime named-pipe lease stays active until the gateway exits. It has no live-owner time expiry and no stale-file deletion race.
- [ ] Documentation says that browser content is untrusted and this is not a browser sandbox.
- [ ] Documentation recommends a separate Chrome profile without sensitive accounts.
- [ ] Documentation says that a mutating timeout is indeterminate and must not be replayed.
- [ ] Documentation says that no defense exists against same-user malware or a local administrator.

## Install and removal checks

- [ ] The installer completes as staged installation with rollback on detected failure.
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

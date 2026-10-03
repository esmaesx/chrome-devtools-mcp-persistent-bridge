import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { localEndpoints } from '../runtime/local-endpoints.mjs';

const source = resolve(import.meta.dirname, '..');
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const install = join(source, 'scripts/install.ps1');
const uninstall = join(source, 'scripts/uninstall.ps1');
const payloadNames = ['runtime', 'scripts', 'package.json', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node_modules'];

function run(command, args, env = {}) {
  const childEnv = { ...process.env, Path: `${dirname(process.execPath)};${process.env.Path || process.env.PATH}`, ...env };
  // Node does not apply PowerShell 7's environment adjustment when it starts
  // Windows PowerShell. Let 5.1 discover its own built-in modules.
  if (command === powershell) for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  }
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, {
      windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      env: childEnv,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return rejectRun(error);
      resolveRun({ code: error?.code || 0, stdout, stderr });
    });
  });
}
const ps = (script, args = [], env) => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], env);
function requireSuccess(result, label) {
  assert.equal(result.code, 0, `${label}: ${result.stdout}\n${result.stderr}`);
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function live(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function hashes(root) {
  const result = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'The installer fixture must not contain reparse links.');
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else result[relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  }
  for (const name of payloadNames) {
    if (['runtime', 'scripts', 'node_modules'].includes(name)) await visit(join(root, name));
    else result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  }
  return result;
}

// This suite creates only a uniquely named, non-elevated task and temporary
// configuration. It never calls a Chrome tool or changes the user's Codex home.
test('Windows PowerShell installer lifecycle with a real owned Scheduled Task', { skip: process.platform !== 'win32', timeout: 240_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'sahar-win-install-'));
  const root = join(parent, 'Bridge caf\u00e9 with spaces');
  const codex = join(parent, 'Codex caf\u00e9');
  const config = join(codex, 'config.toml');
  const taskName = `Sahar Tacit Installer Test ${randomUUID()}`;
  const args = ['-InstallRoot', root, '-CodexHome', codex, '-TaskName', taskName, '-McpServerName', 'sahar-tacit-chrome'];
  const statePath = join(root, 'install-state.json');
  const daemonPath = join(root, 'runtime/daemon.mjs');
  let disabled = false;
  let installed = false;
  let inspection;
  await mkdir(codex, { recursive: true });
  const original = '# caf\u00e9 \u65e5\u672c\u8a9e\r\nmodel = "keep"\r\n[mcp_servers.chrome-devtools]\r\ncommand = "existing-chrome"\r\n[mcp_servers.unrelated]\r\ncommand = "keep-me"\r\n';
  await writeFile(config, original, 'utf8');
  const agents = '# Existing caf\u00e9 guidance.\r\n';
  await writeFile(join(codex, 'AGENTS.md'), agents, 'utf8');
  const inspectPath = join(parent, 'inspect.ps1');
  await writeFile(inspectPath, `param([string]$Root,[string]$TaskName,[string]$Source)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $Source 'scripts/common.ps1')
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$acl=Get-Acl -LiteralPath $Root
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules=@($acl.Access)
$aclOk=$acl.AreAccessRulesProtected -and $rules.Count -eq 2
foreach($rule in $rules){$value=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($value -notin @($sid,'S-1-5-18') -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){$aclOk=$false}}
[pscustomobject]@{exists=[bool]$task;owned=($task -and (Test-OwnedScheduledTask -Task $task -StartScript (Join-Path $Root 'runtime/start-daemon.ps1')));running=([string]$task.State -eq 'Running');limited=([string]$task.Principal.RunLevel -eq 'Limited');privateAcl=$aclOk;powerShell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress
`, 'utf8');
  const inspect = async () => {
    const result = await ps(inspectPath, ['-Root', root, '-TaskName', taskName, '-Source', source]);
    requireSuccess(result, 'task/ACL inspection');
    return JSON.parse(result.stdout.trim());
  };
  const status = async () => {
    const result = await run(process.execPath, [daemonPath, '--status']);
    requireSuccess(result, 'authenticated daemon status');
    return JSON.parse(result.stdout.trim());
  };
  try {
    requireSuccess(await ps(install, args), 'fresh install');
    installed = true;
    inspection = await inspect();
    assert.equal(inspection.owned, true);
    assert.equal(inspection.running, true);
    assert.equal(inspection.limited, true);
    assert.equal(inspection.privateAcl, true);
    assert.match(inspection.powerShell, /^5\.1\./);
    const firstStatus = await status();
    assert.equal(firstStatus.install_root, root);
    const firstState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(firstState.node_path.toLowerCase(), process.execPath.toLowerCase());
    const firstConfig = await readFile(config, 'utf8');
    assert.ok(firstConfig.startsWith(original), 'Installation changed unrelated UTF-8 configuration.');
    assert.equal(await readFile(join(codex, 'AGENTS.md'), 'utf8'), agents);
    t.diagnostic('fresh install: PS 5.1, Unicode paths/config, private ACL, limited owned task, authenticated daemon');

    for (const known of [true, false]) {
      const endpoint = localEndpoints(root).lease;
      const server = net.createServer(socket => {
        socket.once('data', bytes => {
          const request = JSON.parse(String(bytes).trim());
          assert.equal(request.token, firstState.daemon_token);
          socket.end(JSON.stringify(known ? {
            pid: process.pid, parent_pid: process.ppid,
            gateway_instance_id: 'installer-test-owner', lease_instance_id: 'installer-test-lease',
            acquired_at_utc: new Date().toISOString(), last_activity_at_utc: new Date().toISOString(),
            in_flight: true, queue_depth: 1,
          } : { invalid: true }) + '\n');
        });
      });
      server.listen(endpoint);
      await once(server, 'listening');
      try {
        const refused = await ps(install, args);
        assert.notEqual(refused.code, 0);
        assert.match(refused.stderr, known ? /lease_held\)/ : /lease_held_unknown/);
        assert.equal(await readFile(config, 'utf8'), firstConfig);
        assert.equal((await status()).pid, firstStatus.pid);
      } finally { await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())); }
    }
    t.diagnostic('active and unknown lease owners: update refused before any configuration or daemon change');

    const beforeState = await readFile(statePath, 'utf8');
    const beforeHashes = await hashes(root);
    const failed = await ps(install, args, { NODE_ENV: 'test', DEV_NEWB_BRIDGE_TEST_FAIL_AFTER_PAYLOAD_SWAP: '1' });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /Test-only failure injection after payload swap/);
    assert.doesNotMatch(failed.stdout, /Rollback was incomplete/);
    await status(); // Check immediately, before payload hashing can hide a startup race.
    assert.equal(await readFile(config, 'utf8'), firstConfig);
    assert.equal(await readFile(statePath, 'utf8'), beforeState);
    assert.deepEqual(await hashes(root), beforeHashes);
    assert.equal((await inspect()).running, true);
    await status();
    t.diagnostic('failed update: all payload hashes, configuration, state, and running Scheduled Task restored');

    requireSuccess(await ps(install, args), 'idempotent update');
    assert.equal(await readFile(config, 'utf8'), firstConfig);
    assert.equal((firstConfig.match(/\[mcp_servers\.sahar-tacit-chrome\]/g) || []).length, 1);
    const secondState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(secondState.daemon_token, firstState.daemon_token);
    const lastStatus = await status();
    requireSuccess(await ps(uninstall, ['-InstallRoot', root]), 'uninstall');
    disabled = true;
    assert.equal((await inspect()).exists, false);
    assert.equal(live(lastStatus.pid), false);
    assert.equal((await readFile(config, 'utf8')).trimEnd(), original.trimEnd());
    assert.equal(await readFile(join(codex, 'AGENTS.md'), 'utf8'), agents);
    assert.equal(await exists(daemonPath), true);
    assert.ok((await readdir(join(root, 'backups'))).length >= 3);
    t.diagnostic('update/uninstall: one connection, stable token, owned task removed, payload/backups retained');
  } finally {
    if (!disabled && (installed || await exists(statePath))) {
      const cleanup = await ps(uninstall, ['-InstallRoot', root]);
      requireSuccess(cleanup, 'fixture cleanup');
      disabled = true;
    }
    const child = relative(resolve(tmpdir()), parent);
    assert.ok(child && !child.startsWith('..') && !child.includes(sep + '..'));
    // Retain a failed installation for diagnosis if managed cleanup failed.
    if (disabled || !await exists(statePath)) await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('fresh Windows configuration can start empty', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sahar-win-empty-'));
  const root = join(parent, 'Bridge');
  const codex = join(parent, 'Codex');
  const taskName = `Sahar Tacit Empty Test ${randomUUID()}`;
  let installed = false;
  try {
    requireSuccess(await ps(install, ['-InstallRoot', root, '-CodexHome', codex, '-TaskName', taskName, '-McpServerName', 'sahar-tacit-chrome', '-SkipScheduledTask', '-SkipStart']), 'empty configuration install');
    installed = true;
    assert.match(await readFile(join(codex, 'config.toml'), 'utf8'), /\[mcp_servers\.sahar-tacit-chrome\]/);
    requireSuccess(await ps(uninstall, ['-InstallRoot', root]), 'empty configuration uninstall');
    installed = false;
    assert.equal((await readFile(join(codex, 'config.toml'), 'utf8')).trim(), '');
  } finally {
    if (installed) requireSuccess(await ps(uninstall, ['-InstallRoot', root]), 'empty fixture cleanup');
    assert.ok(relative(resolve(tmpdir()), parent).startsWith('sahar-win-empty-'));
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

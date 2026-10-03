import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { manage, launchPlist, splitOwned } from '../scripts/manage-macos.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'sahar-installer-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const options = { root: join(parent, 'Install With Spaces'), config: join(parent, 'codex/config.toml'), plist: join(parent, 'agents/bridge.plist'), source };
  await mkdir(join(parent, 'codex'));
  await writeFile(options.config, 'model = "existing"\n[mcp_servers.other]\ncommand = "keep-me"\n');
  let loaded = false, failStartup = false;
  const calls = [];
  const adapters = {
    idle: async () => {},
    launchctl: async (command, args) => {
      calls.push([command, args]);
      if (command === 'print' && !loaded) throw Object.assign(new Error('absent'), { stderr: 'Could not find service' });
      if (command === 'bootstrap') { if (failStartup) { failStartup = false; throw new Error('injected launch failure'); } loaded = true; }
      if (command === 'bootout') loaded = false;
      return { stdout: '' };
    },
    control: async () => ({ ok: loaded, status: loaded ? 'running' : 'absent' }),
  };
  return { options, adapters, calls, get loaded() { return loaded; }, fail() { failStartup = true; } };
}
test('install, update and uninstall preserve unrelated settings and protected state', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const before = await readFile(f.options.config, 'utf8');
  const result = await manage('install', f.options, f.adapters);
  assert.equal(result.ok, true); assert.equal(f.loaded, true);
  const config = await readFile(f.options.config, 'utf8');
  assert.ok(config.startsWith(before)); assert.match(config, /mcp_servers.sahar-tacit-chrome/);
  const first = JSON.parse(await readFile(join(f.options.root, 'install-state.json')));
  await manage('install', f.options, f.adapters);
  assert.equal(await readFile(f.options.config, 'utf8'), config);
  const second = JSON.parse(await readFile(join(f.options.root, 'install-state.json')));
  assert.equal(first.daemon_token, second.daemon_token);
  await manage('uninstall', f.options, f.adapters);
  assert.equal(f.loaded, false); assert.equal(await readFile(f.options.config, 'utf8'), before);
  await assert.rejects(access(f.options.plist));
  await access(join(f.options.root, 'runtime/stdio-proxy.mjs'));
});
test('startup failure rolls back config, payload, state and prior service', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await manage('install', f.options, f.adapters);
  const state = await readFile(join(f.options.root, 'install-state.json'), 'utf8');
  const config = await readFile(f.options.config, 'utf8');
  f.fail();
  await assert.rejects(manage('install', f.options, f.adapters), /injected launch failure/);
  assert.equal(f.loaded, true);
  assert.equal(await readFile(join(f.options.root, 'install-state.json'), 'utf8'), state);
  assert.equal(await readFile(f.options.config, 'utf8'), config);
});
test('edited managed config refuses update and uninstall before service changes', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await manage('install', f.options, f.adapters);
  const edited = (await readFile(f.options.config, 'utf8')).replace('tool_timeout_sec = 130.0', 'tool_timeout_sec = 99.0');
  await writeFile(f.options.config, edited); const count = f.calls.length;
  await assert.rejects(manage('install', f.options, f.adapters), /edited/);
  await assert.rejects(manage('uninstall', f.options, f.adapters), /edited/);
  assert.equal(f.calls.length, count); assert.equal(await readFile(f.options.config, 'utf8'), edited);
});
test('foreign connection and service names refuse installation', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  await writeFile(f.options.config, '[mcp_servers."sahar-tacit-chrome"]\ncommand="foreign"\n');
  await assert.rejects(manage('install', f.options, f.adapters), /different Codex connection/);
});
test('LaunchAgent arguments escape XML and configuration refuses malformed ownership', () => {
  assert.match(launchPlist('/a & b/node', '/test/<root>'), /a &amp; b/);
  assert.match(launchPlist('/node', '/root'), /RunAtLoad/);
  assert.throws(() => splitOwned('# BEGIN sahar-tacit managed Chrome bridge\n'), /malformed/);
});
test('concurrent config edit during uninstall is preserved and service restored', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await manage('install', f.options, f.adapters);
  const run = f.adapters.launchctl;
  f.adapters.launchctl = async (command, args) => {
    const result = await run(command,args);
    if (command === 'bootout') await writeFile(f.options.config, (await readFile(f.options.config,'utf8')) + '# concurrent edit\n');
    return result;
  };
  await assert.rejects(manage('uninstall', f.options, f.adapters), /changed during setup/);
  assert.equal(f.loaded,true);
  assert.match(await readFile(f.options.config,'utf8'), /concurrent edit/);
  await access(f.options.plist);
});

test('isolated label is recorded and mismatch refuses mutation', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  f.options.label = 'com.sahar-tacit.test-isolated';
  await writeFile(f.options.config, '');
  await manage('install', f.options, f.adapters);
  const state = JSON.parse(await readFile(join(f.options.root, 'install-state.json')));
  assert.equal(state.service_label, f.options.label);
  assert.match(await readFile(f.options.plist, 'utf8'), /com.sahar-tacit.test-isolated/);
  const count = f.calls.length;
  await assert.rejects(manage('uninstall', {...f.options, label: 'com.sahar-tacit.wrong'}, f.adapters), /original LaunchAgent label/);
  assert.equal(f.calls.length, count);
  await manage('uninstall', f.options, f.adapters);
  assert.equal(await readFile(f.options.config, 'utf8'), '');
});
test('rollback waits for authenticated readiness after delayed startup', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await manage('install', f.options, f.adapters);
  let probes = 0;
  f.adapters.control = async () => (++probes < 3 ? {ok:false} : {ok:true,status:'running'});
  f.fail();
  await assert.rejects(manage('install', f.options, f.adapters), /injected launch failure/);
  assert.equal(probes, 3);
});

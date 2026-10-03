#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { access, cp, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const LABEL = 'com.sahar-tacit.chrome-bridge';
const BEGIN = '# BEGIN sahar-tacit managed Chrome bridge';
const END = '# END sahar-tacit managed Chrome bridge';
const SERVER = 'sahar-tacit-chrome';
const PAYLOAD = ['runtime', 'scripts', 'package.json', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node_modules'];
const hash = text => createHash('sha256').update(text).digest('hex');
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function configBlock(node, proxy) {
  return `${BEGIN}\n[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([proxy, 'chrome-devtools'])}\nstartup_timeout_sec = 20.0\ntool_timeout_sec = 130.0\n${END}\n`;
}
export function splitOwned(text, expectedHash) {
  const starts = [...text.matchAll(/^# BEGIN sahar-tacit managed Chrome bridge\r?$/gm)];
  const ends = [...text.matchAll(/^# END sahar-tacit managed Chrome bridge\r?$/gm)];
  if (!starts.length && !ends.length) {
    if (expectedHash) throw new Error('The managed Codex block is missing. Restore it before updating or uninstalling.');
    if (/^\s*\[\s*mcp_servers\s*\.\s*["']?sahar-tacit-chrome(?:["']?\s*\]|["']?\s*\.)/m.test(text)) throw new Error('A different Codex connection already uses sahar-tacit-chrome.');
    return { before: text, after: '', block: '' };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error('The managed Codex block is malformed.');
  const start = starts[0].index, end = ends[0].index + ends[0][0].length + (text[ends[0].index + ends[0][0].length] === '\n' ? 1 : 0);
  const block = text.slice(start, end);
  if (!expectedHash || hash(block) !== expectedHash) throw new Error('The managed Codex block was edited or is not owned by this installation.');
  return { before: text.slice(0, start), block, after: text.slice(end) };
}
export function launchPlist(node, root, label = LABEL) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(root, 'runtime/daemon.mjs'))}</string></array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(join(root, 'logs/daemon.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(root, 'logs/daemon-error.log'))}</string>\n</dict></plist>\n`;
}
async function readOptional(path) { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function safePath(path) {
  let current = resolve(path);
  while (true) {
    try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error(`Refusing a symbolic-link path: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function writeAtomic(path, text) {
  await safePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}
async function compareWrite(path, before, after) {
  if (await readOptional(path) !== before) throw new Error(`File changed during setup: ${path}`);
  await writeAtomic(path, after);
}
async function daemonControl(root, mode, node = process.execPath) {
  try { const r = await exec(node, [join(root, 'runtime/daemon.mjs'), mode], { timeout: 12000 }); return JSON.parse(r.stdout); }
  catch (e) { try { return JSON.parse(e.stdout); } catch { return { ok: false, status: 'unknown' }; } }
}
async function assertIdle(root) {
  const state = await readOptional(join(root, 'install-state.json'));
  if (!state) return;
  const lease = await daemonControl(root, '--lease-status');
  if (lease.state !== 'free') throw new Error('The bridge lease is active or unknown. Finish agent work before updating or uninstalling.');
  const { stdout } = await exec('/bin/ps', ['-axo', 'command=']);
  if (stdout.split('\n').some(line => line.includes(join(root, 'runtime/stdio-proxy.mjs')) && line.includes('chrome-devtools'))) throw new Error('A bridge client is still open. Close its session, then rerun setup.');
  const status = await daemonControl(root, '--status');
  if (status.ok !== true && status.cause !== 'daemon_absent') throw new Error('The existing daemon state is uncertain. Run status before changing the installation.');
}
async function serviceLoaded(run, label) {
  try { await run('print', [`gui/${process.getuid()}/${label}`]); return true; }
  catch (e) { if (String(e.stderr).includes('Could not find service')) return false; throw e; }
}
async function waitForReady(root, control) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const status = await control(root, '--status');
    if (status.ok === true && status.status === 'running') return;
    await pause(250);
  }
  throw new Error('The service did not become ready. Inspect the retained logs.');
}

export async function manage(action, options = {}, adapters = {}) {
  if (process.platform !== 'darwin') throw new Error('This setup command is for macOS.');
  const label = options.label || LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,100}$/.test(label)) throw new Error('Invalid LaunchAgent label.');
  const root = resolve(options.root || join(homedir(), 'Library/Application Support/Sahar Tacit/Chrome Bridge'));
  const config = resolve(options.config || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'));
  const plist = resolve(options.plist || join(homedir(), 'Library/LaunchAgents', label + '.plist'));
  const statePath = join(root, 'install-state.json');
  const run = adapters.launchctl || ((command, args) => exec('/bin/launchctl', [command, ...args], { timeout: 15000 }));
  const control = adapters.control || daemonControl;
  const idle = adapters.idle || assertIdle;
  if (action === 'status') {
    const status = await control(root, '--status');
    return { installed: !!(await readOptional(statePath)), running: status.ok === true, status: status.status, root,
      next: status.ok ? 'Bridge is running. Run check to verify Chrome access.' : 'Run setup to install or restart the bridge.' };
  }
  if (!['install', 'uninstall'].includes(action)) throw new Error('Use install, status, check, or uninstall. Update uses the same install command.');
  for (const path of [root, config, plist]) await safePath(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077)) throw new Error('The install directory must be owned by you with mode 0700.');
  const lockPath = join(root, '.setup.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another setup may be running. Check the install directory before retrying.'); });
  try {
    const oldRaw = await readOptional(statePath), old = oldRaw ? JSON.parse(oldRaw) : null;
    if (old && (old.install_root !== root || old.manager !== LABEL)) throw new Error('This directory belongs to a different installation.');
    if (old && (old.config_path !== config || old.plist_path !== plist)) throw new Error('Use the original configuration and LaunchAgent paths for this installation.');
    if (old && (old.service_label || LABEL) !== label) throw new Error('Use the original LaunchAgent label for this installation.');
    const oldConfig = await readOptional(config), oldPlist = await readOptional(plist);
    const owned = splitOwned(oldConfig || '', old?.config_block_sha256);
    if (oldPlist !== null && (!old || hash(oldPlist) !== old.plist_sha256)) throw new Error('The LaunchAgent is not owned by this installation or was edited.');
    if (old && !oldPlist) throw new Error('The managed LaunchAgent is missing. Restore it before updating or uninstalling.');
    const loaded = await serviceLoaded(run, label);
    if (loaded && !old) throw new Error('Another LaunchAgent already uses this service name.');
    await idle(root);
    const revision = options.revision || 'local';
    if (!/^(local|[a-f0-9]{40})$/.test(revision)) throw new Error('Revision must be a commit SHA.');
    const transaction = join(root, 'backups', Date.now() + '-' + randomBytes(4).toString('hex'));
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    if (oldConfig !== null) await writeFile(join(transaction, 'config.toml'), oldConfig, { mode: 0o600 });
    if (oldPlist !== null) await writeFile(join(transaction, 'agent.plist'), oldPlist, { mode: 0o600 });
    if (oldRaw !== null) await writeFile(join(transaction, 'install-state.json'), oldRaw, { mode: 0o600 });
    if (action === 'uninstall') {
      if (!old) throw new Error('No managed installation found.');
      const newConfig = owned.before + owned.after;
      let stopped = false, configChanged = false, plistMoved = false;
      try {
        if (loaded) { await run('bootout', [`gui/${process.getuid()}`, plist]); stopped = true; }
        await compareWrite(config, oldConfig, newConfig); configChanged = true;
        await rename(plist, join(transaction, 'removed-agent.plist')); plistMoved = true;
        await rename(statePath, join(transaction, 'removed-install-state.json'));
      } catch (error) {
        if (configChanged && await readOptional(config) === newConfig) await writeAtomic(config, oldConfig);
        if (plistMoved) await rename(join(transaction, 'removed-agent.plist'), plist);
        if (stopped) { await run('bootstrap', [`gui/${process.getuid()}`, plist]); await waitForReady(root, control); }
        throw error;
      }
      return { ok: true, message: 'Bridge disabled; managed Codex connection and login service removed. Files and backups retained.', root };
    }
    const source = await realpath(resolve(options.source || fileURLToPath(new URL('../', import.meta.url))));
    if (source === root || source.startsWith(root + '/')) throw new Error('Install from a separate downloaded source directory.');
    const stage = join(root, '.stage-' + randomBytes(8).toString('hex'));
    await mkdir(stage, { mode: 0o700 });
    for (const item of PAYLOAD) await cp(join(source, item), join(stage, item), { recursive: true, dereference: false });
    await access(join(stage, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'));
    await exec(process.execPath, ['--check', join(stage, 'runtime/daemon.mjs')]);
    if (await readOptional(config) !== oldConfig || await readOptional(plist) !== oldPlist) throw new Error('Configuration changed during preparation. Nothing was replaced.');
    await idle(root);
    const installed = [], replaced = [];
    let newConfig = null, newPlist = null, serviceStopped = false;
    try {
      if (loaded) { await run('bootout', [`gui/${process.getuid()}`, plist]); serviceStopped = true; }
      for (const item of PAYLOAD) {
        try { await rename(join(root, item), join(transaction, item)); replaced.push(item); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await rename(join(stage, item), join(root, item)); installed.push(item);
      }
      if (process.env.NODE_ENV === 'test' && process.env.SAHAR_TACIT_TEST_FAIL_AFTER_PAYLOAD_SWAP === '1') throw new Error('Test-only failure after payload swap.');
      const block = configBlock(process.execPath, join(root, 'runtime/stdio-proxy.mjs'));
      newConfig = owned.before + (owned.before && !owned.before.endsWith('\n') ? '\n' : '') + block + owned.after;
      newPlist = launchPlist(process.execPath, root, label);
      await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 });
      await compareWrite(config, oldConfig, newConfig);
      await compareWrite(plist, oldPlist, newPlist);
      const state = { manager: LABEL, service_label: label, install_root: root, node_path: process.execPath, package_version: '0.1.3', revision,
        config_path: config, config_block_sha256: hash(block), plist_path: plist, plist_sha256: hash(newPlist),
        daemon_token: old?.daemon_token || randomBytes(32).toString('hex') };
      await writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n');
      await run('bootstrap', [`gui/${process.getuid()}`, plist]);
      await waitForReady(root, control);
      await rm(stage, { recursive: true, force: true });
      return { ok: true, root, message: 'Bridge installed and starts at login. Restart Codex to load sahar-tacit-chrome. Run check to verify Chrome access.', revision };
    } catch (error) {
      try { await run('bootout', [`gui/${process.getuid()}`, plist]); } catch { }
      if (newConfig !== null && await readOptional(config) === newConfig) await writeAtomic(config, oldConfig || '');
      if (newPlist !== null && await readOptional(plist) === newPlist) {
        if (oldPlist !== null) await writeAtomic(plist, oldPlist); else await rm(plist);
      }
      for (const item of installed.reverse()) await rename(join(root, item), join(transaction, 'failed-' + item));
      for (const item of replaced) await rename(join(transaction, item), join(root, item));
      if (oldRaw !== null) await writeAtomic(statePath, oldRaw); else await rm(statePath, { force: true });
      if (serviceStopped && oldPlist) { await run('bootstrap', [`gui/${process.getuid()}`, plist]); await waitForReady(root, control); }
      throw error;
    }
  } finally { await lock.close(); await rm(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action = 'status', ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root','--source','--revision','--config','--plist','--label'].includes(args[i]) || !args[i+1]) throw new Error('Invalid setup arguments.');
    options[args[i].slice(2)] = args[i+1];
  }
  try {
    if (action === 'check') {
      const root = resolve(options.root || join(homedir(), 'Library/Application Support/Sahar Tacit/Chrome Bridge'));
      const checker = join(root, 'scripts/check-connection.mjs');
      try {
        const r = await exec(process.execPath, [checker], { timeout: 25000 }); process.stdout.write(r.stdout);
      } catch (error) {
        if (error.stdout) process.stdout.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        process.exitCode = Number.isInteger(error.code) ? error.code : 1;
      }
    } else console.log(JSON.stringify(await manage(action, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

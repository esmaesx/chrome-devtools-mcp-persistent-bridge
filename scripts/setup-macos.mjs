#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { prepareEndpoints, validatePrivateState } from '../runtime/local-endpoints.mjs';

if (process.platform !== 'darwin') throw new Error('Use the Windows installer on Windows.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const info = await lstat(root);
if (info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error('The checkout must be owned by you and not writable by other users.');
await access(join(root, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'));
await prepareEndpoints(root);
const statePath = join(root, 'install-state.json');
try {
  await writeFile(statePath, JSON.stringify({ install_root: root, node_path: process.execPath,
    package_version: '0.1.3', daemon_token: randomBytes(32).toString('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  await validatePrivateState(statePath);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.install_root !== root || typeof state.daemon_token !== 'string' || state.daemon_token.length < 32) throw new Error('Existing install state does not match this checkout.');
}
console.log('Setup complete. No browser, daemon, or Codex configuration was changed.');
console.log(`Start: node ${JSON.stringify(join(root, 'runtime/daemon.mjs'))}`);
console.log(`Status: node ${JSON.stringify(join(root, 'runtime/daemon.mjs'))} --status`);
console.log(`Stop: node ${JSON.stringify(join(root, 'runtime/daemon.mjs'))} --stop`);
console.log(`MCP command: ${process.execPath}`);
console.log(`MCP args: ${JSON.stringify([join(root, 'runtime/stdio-proxy.mjs'), 'chrome-devtools'])}`);

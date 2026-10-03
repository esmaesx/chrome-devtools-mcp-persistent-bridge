import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, realpath, writeFile, symlink, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localEndpoints, validatePrivateState, prepareEndpoints } from '../runtime/local-endpoints.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(path, body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let bytes = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('IPC timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => {
      bytes += chunk;
      if (bytes.includes('\n')) {
        socket.destroy();
        try { resolve(JSON.parse(bytes.split('\n')[0])); } catch (e) { reject(e); }
      }
    });
  });
}
test('macOS authenticated sockets, private state, MCP calls, and manual permission recovery', { skip: process.platform !== 'darwin' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sahar-tacit-mac-test-')));
  let daemon, transport, client, waiter, waiterTransport;
  const token = randomBytes(32).toString('hex');
  const endpoints = await prepareEndpoints(root);
  let stderr = '';
  try {
    await mkdir(join(root, 'runtime'));
    for (const name of ['daemon.mjs', 'stdio-proxy.mjs', 'local-endpoints.mjs']) await cp(join(source, 'runtime', name), join(root, 'runtime', name));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    const statePath = join(root, 'install-state.json');
    await writeFile(statePath, JSON.stringify({ install_root: root, node_path: process.execPath, daemon_token: token }), { mode: 0o600 });
    await validatePrivateState(statePath);
    await chmod(statePath, 0o644);
    await assert.rejects(validatePrivateState(statePath), /owner-only/);
    await chmod(statePath, 0o600);
    assert.equal((await lstat(endpoints.directory)).mode & 0o777, 0o700);
    assert.ok(localEndpoints(root, 'win32').daemon.startsWith('\\\\.\\pipe\\sahar-tacit-chrome-daemon-'));
    const env = { ...process.env, NODE_ENV: 'test', CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND: '1', CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000', CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '80', CHROME_DEVTOOLS_MCP_TEST_BACKEND: join(source, 'tests/fake-chrome-server.mjs') };
    daemon = spawn(process.execPath, [join(root, 'runtime/daemon.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stderr.on('data', chunk => { stderr += chunk; });
    let status;
    for (let i = 0; i < 100; i++) {
      if (daemon.exitCode !== null) throw new Error(stderr);
      try { status = await request(endpoints.daemon, { operation: 'status', token }); break; } catch { await delay(50); }
    }
    assert.equal(status?.status, 'running', stderr);
    const denied = await request(endpoints.daemon, { operation: 'status', token: 'wrong' });
    assert.notEqual(denied.ok, true);
    client = new Client({ name: 'mac-test', version: '1' });
    transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'runtime/stdio-proxy.mjs'), 'chrome-devtools', '--lease-wait-ms', '5000'], cwd: root, env, stderr: 'pipe' });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 30);
    assert.notEqual((await client.callTool({ name: 'list_pages', arguments: {} })).isError, true);
    const recovery = await client.callTool({ name: 'allow_remote_debugging', arguments: {} });
    assert.equal(recovery.structuredContent.status, 'manual_permission_required');
    assert.equal(recovery.structuredContent.mutated, false);
    waiter = new Client({ name: 'mac-handoff-test', version: '1' });
    waiterTransport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'runtime/stdio-proxy.mjs'), 'chrome-devtools', '--lease-wait-ms', '5000'], cwd: root, env, stderr: 'pipe' });
    await waiter.connect(waiterTransport);
    await delay(100);
    assert.notEqual((await waiter.callTool({ name: 'list_pages', arguments: {} })).isError, true, 'Idle owner did not cooperatively yield');
    await delay(100);
    const reacquired = await client.callTool({ name: 'list_pages', arguments: {} });
    assert.notEqual(reacquired.isError, true, JSON.stringify(reacquired));
    await waiter.close(); waiter = null;
    await client.close(); client = null;
    await request(endpoints.daemon, { operation: 'stop', token });
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await delay(50);
    assert.notEqual(daemon.exitCode, null, 'Owned test daemon failed to stop');
  } finally {
    await waiter?.close().catch(() => {});
    await waiterTransport?.close().catch(() => {});
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      for (let i = 0; i < 100 && daemon.exitCode === null; i++) await delay(50);
    }
    if (!daemon || daemon.exitCode !== null) await rm(root, { recursive: true, force: true });
  }
});

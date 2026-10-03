#!/usr/bin/env node

import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const execFileAsync = promisify(execFile);
const nodeModules = join(repositoryRoot, 'node_modules');
const fakeBackend = join(repositoryRoot, 'tests', 'fake-chrome-server.mjs');
const parentHelper = join(repositoryRoot, 'tests', 'gateway-parent-helper.mjs');
const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const preflightScript = join(repositoryRoot, 'scripts', 'preflight-install.ps1');
const installScript = join(repositoryRoot, 'scripts', 'install.ps1');

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const textOf = (value) => JSON.stringify(value);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(result, status, message) {
  expect(result?.isError === true && textOf(result).includes(status), message);
}

function leasePipeFor(root) {
  const rootHash = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\sahar-tacit-chrome-control-${rootHash}`;
}

function daemonPipeFor(root) {
  const rootHash = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\sahar-tacit-chrome-daemon-${rootHash}`;
}

function processIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause.code !== 'ESRCH'; }
}

async function waitForCondition(callback, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await callback()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  await waitForCondition(() => !processIsLive(pid), timeoutMs, `Test process ${pid} did not exit.`);
}

async function parsedDaemonStatus(root) {
  const { stdout } = await daemonCommand(root, '--status');
  const lines = stdout.trim().split(/\r?\n/);
  expect(lines.length === 1, 'Daemon status emitted more than one JSON object.');
  return JSON.parse(lines[0]);
}

async function statusScriptResult(root, env = process.env) {
  const result = await runPowerShellScript(join(root, 'runtime', 'status.ps1'), [], root, env);
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines.length === 1, 'status.ps1 emitted more than one JSON object.');
  expect(result.stderr.trim() === '', 'status.ps1 emitted an unsanitized stderr diagnostic.');
  return { ...result, value: JSON.parse(lines[0]) };
}

async function parsedScriptStatus(root) {
  return (await statusScriptResult(root)).value;
}

function runPowerShellScript(script, args, cwd = repositoryRoot, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { cwd, env, windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && error.killed) return rejectRun(error);
      resolveRun({ exitCode: Number.isSafeInteger(error?.code) ? error.code : 0, stdout, stderr });
    });
  });
}

async function installPreflight(root) {
  const result = await runPowerShellScript(preflightScript, ['-InstallRoot', root]);
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines.length === 1, 'Install preflight emitted more than one JSON object.');
  return { ...result, value: JSON.parse(lines[0]) };
}

function waitForChildExit(child, timeoutMs = 7_000) {
  return Promise.race([
    once(child, 'exit'),
    delay(timeoutMs).then(() => { throw new Error('The child process did not exit in time.'); }),
  ]);
}

function rawLeaseStatus(root, token = 'a'.repeat(64), timeoutMs = 1_000) {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = net.createConnection(leasePipeFor(root));
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(rejectStatus, new Error('Raw lease status timed out.')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'status', token })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(resolveStatus, JSON.parse(buffer.slice(0, newline))); } catch (cause) { finish(rejectStatus, cause); }
    });
    socket.once('close', () => finish(resolveStatus, null));
    socket.once('error', (cause) => finish(rejectStatus, cause));
  });
}

function beginRawLeaseControl(root, request, timeoutMs = 1_000, { allowHalfOpen = false } = {}) {
  const socket = net.createConnection({ path: leasePipeFor(root), allowHalfOpen });
  let buffer = '';
  let settled = false;
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolveValue, rejectValue) => {
    resolveResponse = resolveValue;
    rejectResponse = rejectValue;
  });
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  const timer = setTimeout(() => {
    socket.destroy();
    finish(rejectResponse, new Error('Raw lease control request timed out.'));
  }, timeoutMs);
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    if (buffer.slice(newline + 1).trim().length > 0) return finish(rejectResponse, new Error('Raw lease control response contained extra data.'));
    try { finish(resolveResponse, JSON.parse(buffer.slice(0, newline))); } catch (cause) { finish(rejectResponse, cause); }
  });
  socket.once('close', () => finish(resolveResponse, null));
  socket.once('error', (cause) => finish(rejectResponse, cause));
  return { socket, response };
}

async function leasePipeIsBindable(root) {
  const candidate = net.createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      candidate.once('error', rejectListen);
      candidate.once('listening', resolveListen);
      candidate.listen(leasePipeFor(root));
    });
    return true;
  } catch (cause) {
    if (cause.code === 'EADDRINUSE') return false;
    throw cause;
  } finally {
    try { await new Promise((resolveClose) => candidate.close(resolveClose)); } catch { }
  }
}

function beginRawDaemonRequest(root, request, timeoutMs = 10_000) {
  let resolveSent;
  let rejectSent;
  let sentSettled = false;
  const sent = new Promise((resolveRequestSent, rejectRequestSent) => {
    resolveSent = resolveRequestSent;
    rejectSent = rejectRequestSent;
  });
  const result = new Promise((resolveResult, rejectResult) => {
    const socket = net.createConnection(daemonPipeFor(root));
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const fail = (cause) => {
      if (!sentSettled) {
        sentSettled = true;
        rejectSent(cause);
      }
      finish(rejectResult, cause);
    };
    const timer = setTimeout(() => fail(new Error('Raw daemon request timed out.')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`, () => {
        if (sentSettled) return;
        sentSettled = true;
        resolveSent();
      });
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(resolveResult, JSON.parse(buffer.slice(0, newline))); } catch (cause) { fail(cause); }
    });
    socket.once('close', () => {
      if (!settled) fail(new Error('Raw daemon connection closed before a result.'));
    });
    socket.once('error', fail);
  });
  return { sent, result };
}

function readChildJsonLine(child, timeoutMs = 5_000) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      callback(value);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(resolveLine, JSON.parse(buffer.slice(0, newline))); } catch (cause) { finish(rejectLine, cause); }
    };
    const onExit = (code) => finish(rejectLine, new Error(`Parent helper exited before readiness (${code ?? 'unknown'}).`));
    const timer = setTimeout(() => finish(rejectLine, new Error('Parent helper did not report readiness.')), timeoutMs);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

async function eventCount(path, name) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().length === 0 ? 0 : text.trim().split(/\r?\n/).map((line) => JSON.parse(line)).filter((entry) => entry.name === name).length;
  } catch (cause) {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  }
}

async function readJsonLines(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().length === 0 ? [] : text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function daemonCommand(root, argument) {
  return execFileAsync(process.execPath, [join(root, 'runtime', 'daemon.mjs'), argument], {
    cwd: root,
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
  });
}

async function waitForStatus(root, expectedInstanceId) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const { stdout } = await daemonCommand(root, '--status');
      const lines = stdout.trim().split(/\r?\n/);
      expect(lines.length === 1, 'Daemon status emitted more than one JSON object.');
      const status = JSON.parse(lines[0]);
      if (status.status === 'running' && (!expectedInstanceId || status.daemon_instance_id !== expectedInstanceId)) return status;
    } catch (cause) {
      lastError = cause;
    }
    await delay(100);
  }
  throw new Error(`Daemon did not become ready: ${lastError?.message ?? 'unknown failure'}`);
}

async function startDaemon(fixture, previousInstanceId) {
  const child = spawn(process.execPath, [join(fixture.root, 'runtime', 'daemon.mjs')], {
    cwd: fixture.root,
    env: fixture.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const status = await waitForStatus(fixture.root, previousInstanceId);
  fixture.daemons.push({ child, stderr: () => stderr, status });
  return status;
}

async function stopDaemon(fixture) {
  const current = fixture.daemons.at(-1);
  if (!current || current.child.exitCode !== null) return;
  const { stdout } = await daemonCommand(fixture.root, '--stop');
  const lines = stdout.trim().split(/\r?\n/);
  expect(lines.length === 1, 'Daemon stop emitted more than one JSON object.');
  const stopped = JSON.parse(lines[0]);
  expect(stopped.status === 'stopped' && stopped.pid === current.status.pid, 'Daemon stop was not confirmed for the reported PID.');
  if (current.child.exitCode === null) {
    await Promise.race([once(current.child, 'exit'), delay(5_000).then(() => { throw new Error('Daemon child did not exit.'); })]);
  }
}

async function createFixture(label, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), `chrome-bridge-${label}-`));
  await mkdir(join(root, 'runtime'), { recursive: true });
  for (const file of ['daemon.mjs', 'stdio-proxy.mjs', 'allow-remote-debugging.ps1', 'status.ps1']) {
    await cp(join(repositoryRoot, 'runtime', file), join(root, 'runtime', file));
  }
  await symlink(nodeModules, join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'install-state.json'), JSON.stringify({ install_root: root, daemon_token: 'a'.repeat(64), node_path: process.execPath, package_version: '0.1.3' }), 'utf8');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND: '1',
    CHROME_DEVTOOLS_MCP_TEST_BACKEND: fakeBackend,
    CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '250',
    ...overrides,
  };
  const fixture = { root, env, daemons: [], transports: [], transportByClient: new Map(), stderrByClient: new Map() };
  await startDaemon(fixture);
  return fixture;
}

async function connectGateway(fixture, name, { leaseWaitMs } = {}) {
  const client = new Client({ name, version: '0.1.3' }, { capabilities: {} });
  const args = [join(fixture.root, 'runtime', 'stdio-proxy.mjs'), 'chrome-devtools'];
  if (leaseWaitMs !== undefined) args.push('--lease-wait-ms', String(leaseWaitMs));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: fixture.root,
    env: fixture.env,
    stderr: 'pipe',
  });
  let stderr = '';
  try {
    await client.connect(transport);
  } catch (cause) {
    throw new Error(`Gateway connection failed: ${cause.message}\n${stderr}`);
  }
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  fixture.transports.push(transport);
  fixture.transportByClient.set(client, transport);
  fixture.stderrByClient.set(client, () => stderr);
  return client;
}

async function closeGateway(fixture, client) {
  const transport = fixture.transportByClient.get(client);
  if (!transport) return;
  fixture.transportByClient.delete(client);
  fixture.stderrByClient.delete(client);
  const index = fixture.transports.indexOf(transport);
  if (index >= 0) fixture.transports.splice(index, 1);
  await transport.close();
}

function fixtureTransportPid(fixture, client) {
  return fixture.transportByClient.get(client)?.pid;
}

async function closeFixture(fixture) {
  for (const transport of fixture.transports.splice(0)) {
    try { await transport.close(); } catch { }
  }
  fixture.transportByClient.clear();
  fixture.stderrByClient.clear();
  try { await stopDaemon(fixture); } catch { }
  for (const daemon of fixture.daemons) {
    if (daemon.child.exitCode === null) {
      daemon.child.kill('SIGTERM');
      await Promise.race([once(daemon.child, 'exit'), delay(2_000)]);
    }
  }
  const tempBase = resolve(tmpdir());
  if (!resolve(fixture.root).startsWith(tempBase) || !basename(fixture.root).startsWith('chrome-bridge-')) throw new Error('Temporary test cleanup path failed its guard.');
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function callWithOptions(client, name, args, options) {
  return client.callTool({ name, arguments: args }, undefined, options);
}

async function normalFlowAndInvalidList() {
  const fixture = await createFixture('normal');
  try {
    const parsedStatus = await parsedDaemonStatus(fixture.root);
    for (const field of ['pid', 'install_root', 'pipe', 'backend_connected', 'backend_generation']) expect(Object.hasOwn(parsedStatus, field), `Status command is missing ${field}.`);
    expect(parsedStatus.lease?.state === 'free', 'Daemon status did not report a free lease.');
    const scriptStatusResult = await statusScriptResult(fixture.root);
    const scriptStatus = scriptStatusResult.value;
    expect(scriptStatusResult.exitCode === 0, `status.ps1 returned ${scriptStatusResult.exitCode} for a healthy daemon: ${textOf(scriptStatus)}`);
    expect(scriptStatus.schema_version === 2 && scriptStatus.daemon?.status === 'running' && scriptStatus.daemon.cause === null && scriptStatus.lease?.state === 'free', 'status.ps1 did not return its normal daemon and lease schema.');

    const client = await connectGateway(fixture, 'gateway-normal');
    const tools = await client.listTools();
    expect(tools.tools.length === 30 && tools.tools.some((tool) => tool.name === 'allow_remote_debugging'), 'Gateway did not expose the reviewed manifest plus recovery tool.');
    expectError(await call(client, 'list_pages', { unexpected: true }), 'blocked_arguments', 'Invalid list_pages arguments were accepted.');
    expectError(await call(client, 'allow_remote_debugging'), 'blocked_not_eligible', 'Invalid list_pages arguments enabled recovery.');
    expectError(await call(client, 'click'), 'blocked_discovery_required', 'Discovery order was not enforced.');
    expect(!(await call(client, 'list_pages')).isError, 'Valid list_pages failed.');
    expectError(await call(client, 'take_snapshot'), 'blocked_selection_required', 'Selection order was not enforced.');
    expect(!(await call(client, 'select_page')).isError, 'Valid select_page failed.');
    expect(!(await call(client, 'take_snapshot')).isError, 'Normal flow did not reach a read-only tool.');
  } finally {
    await closeFixture(fixture);
  }
}

async function taskLease() {
  const fixture = await createFixture('lease', { CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '750' });
  try {
    const first = await connectGateway(fixture, 'gateway-lease-first');
    const second = await connectGateway(fixture, 'gateway-lease-second');
    expect(!(await call(first, 'list_pages')).isError, 'First gateway could not acquire the task lease.');
    const held = await parsedDaemonStatus(fixture.root);
    const firstTransport = fixture.transportByClient.get(first);
    expect(held.lease?.state === 'held' && held.lease.pid === firstTransport.pid, 'Lease status did not identify the first gateway.');
    const scriptStatus = await parsedScriptStatus(fixture.root);
    expect(scriptStatus.daemon?.status === 'running' && scriptStatus.lease?.state === 'held', 'status.ps1 did not separate a running daemon from a held lease.');
    const rawStatus = await rawLeaseStatus(fixture.root);
    const rawKeys = Object.keys(rawStatus ?? {}).sort();
    const allowedKeys = ['acquired_at_utc', 'gateway_instance_id', 'in_flight', 'last_activity_at_utc', 'lease_instance_id', 'parent_pid', 'pid', 'queue_depth'];
    expect(rawKeys.length === allowedKeys.length && rawKeys.every((key, index) => key === allowedKeys[index]), 'The lease pipe exposed data outside the approved owner facts.');
    expect(await rawLeaseStatus(fixture.root, 'b'.repeat(64)) === null, 'The lease pipe answered an unauthenticated status request.');
    const started = Date.now();
    const busy = await call(second, 'list_pages');
    const elapsed = Date.now() - started;
    expectError(busy, 'lease_busy', 'Second gateway acquired the task lease.');
    expect(elapsed <= 1_000, `Busy acquisition took ${elapsed} ms.`);
    expect(busy.structuredContent?.owner_pid === firstTransport.pid, 'Busy result did not identify the owner PID.');
    expect(busy.structuredContent?.owner_parent_pid === process.pid, 'Busy result did not identify the owner parent PID.');
    expect(typeof busy.structuredContent?.owner_gateway_instance_id === 'string', 'Busy result omitted the gateway instance ID.');
    expect(busy.structuredContent?.dispatched === false, 'Busy result reported a dispatched Chrome call.');
  } finally {
    await closeFixture(fixture);
  }
}

async function authenticatedIdleYieldHandshake() {
  const events = join(tmpdir(), `chrome-bridge-idle-yield-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('idle-yield-protocol', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '80',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS: '300',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-idle-yield-owner');
    expect(!(await call(owner, 'list_pages')).isError, 'Idle-yield owner could not acquire the lease.');
    await delay(100);
    const original = await rawLeaseStatus(fixture.root);
    expect(typeof original?.lease_instance_id === 'string' && original.lease_instance_id.length > 0, 'Lease status omitted the per-acquisition lease ID.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === original.lease_instance_id, 'Authenticated status changed the lease.');

    const invalid = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'b'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    expect(await invalid.response === null, 'An invalid token received a yield response.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === original.lease_instance_id, 'An invalid token yielded the lease.');

    const stale = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: 'stale-lease-instance',
    });
    const staleReply = await stale.response;
    expect(staleReply?.accepted === false && staleReply.reason === 'stale_lease', 'A stale lease ID was not refused.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === original.lease_instance_id, 'A stale lease ID yielded the lease.');

    const unacknowledged = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    const accepted = await unacknowledged.response;
    const acceptedKeys = Object.keys(accepted ?? {}).sort();
    const expectedReplyKeys = ['accepted', 'gateway_instance_id', 'lease_instance_id', 'operation', 'reason'];
    expect(acceptedKeys.length === expectedReplyKeys.length && acceptedKeys.every((key, index) => key === expectedReplyKeys[index]), 'The accepted yield response did not contain one exact bounded schema.');
    expect(accepted.accepted === true && accepted.gateway_instance_id === original.gateway_instance_id && accepted.lease_instance_id === original.lease_instance_id, 'The yield response did not match both owner IDs.');
    expect(!(await leasePipeIsBindable(fixture.root)), 'The lease pipe became bindable before the complete matching response was read and acknowledged.');
    const duringPending = await call(owner, 'list_pages');
    expectError(duringPending, 'lease_yielding', 'A tool that arrived after yield acceptance was not blocked.');
    expect(duringPending.structuredContent?.dispatched === false, 'A tool that arrived during a pending yield reported a dispatch.');
    expect((await eventCount(events, 'list_pages')) === 1, 'A tool arrived during a pending yield and reached Chrome.');
    const simultaneous = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    const simultaneousReply = await simultaneous.response;
    expect(simultaneousReply?.accepted === false && simultaneousReply.reason === 'yield_pending', 'Two simultaneous yield requests created more than one pending handoff.');
    unacknowledged.socket.destroy();
    await delay(350);
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === original.lease_instance_id, 'An unacknowledged yield released the lease later.');

    const invalidAcks = [
      {
        label: 'wrong-token',
        value: JSON.stringify({ operation: 'yield_ack', token: 'b'.repeat(64), gateway_instance_id: original.gateway_instance_id, lease_instance_id: original.lease_instance_id }),
      },
      {
        label: 'wrong-ID',
        value: JSON.stringify({ operation: 'yield_ack', token: 'a'.repeat(64), gateway_instance_id: original.gateway_instance_id, lease_instance_id: 'wrong-lease-instance' }),
      },
      { label: 'malformed', value: '{not-json' },
    ];
    for (const invalidAck of invalidAcks) {
      const pendingInvalid = beginRawLeaseControl(fixture.root, {
        operation: 'yield',
        token: 'a'.repeat(64),
        gateway_instance_id: original.gateway_instance_id,
        lease_instance_id: original.lease_instance_id,
      });
      expect((await pendingInvalid.response)?.accepted === true, `The ${invalidAck.label} ACK test did not enter the pending state.`);
      const invalidClosed = once(pendingInvalid.socket, 'close');
      pendingInvalid.socket.end(`${invalidAck.value}\n`);
      await withTimeout(invalidClosed, 1_000, `The ${invalidAck.label} ACK connection did not close.`);
      expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === original.lease_instance_id, `The ${invalidAck.label} ACK changed the owner lease.`);
      expect(!(await leasePipeIsBindable(fixture.root)), `The ${invalidAck.label} ACK released the lease.`);
    }

    const acknowledged = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    expect((await acknowledged.response)?.accepted === true, 'The matching idle yield was not accepted.');
    acknowledged.socket.write(`${JSON.stringify({
      operation: 'yield_ack',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    })}\n`, () => acknowledged.socket.end());
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 2_000, 'The acknowledged idle yield did not release the lease.');

    expect(!(await call(owner, 'list_pages')).isError, 'The prior owner could not reacquire with fresh state.');
    const reacquired = await rawLeaseStatus(fixture.root);
    expect(reacquired.gateway_instance_id === original.gateway_instance_id && reacquired.lease_instance_id !== original.lease_instance_id, 'A lease reacquisition did not create a fresh lease instance ID.');
    const oldLeaseRequest = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    expect((await oldLeaseRequest.response)?.accepted === false, 'A request from an earlier lease affected a later lease.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === reacquired.lease_instance_id, 'A stale request released the later lease.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function defaultGatewayIsFailFastAndQueueTimeoutDispatchesNothing() {
  const events = join(tmpdir(), `chrome-bridge-default-wait-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('default-wait', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '',
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '100',
    FAKE_CHROME_DELAY_TOOL: 'take_snapshot',
    FAKE_CHROME_DELAY_MS: '1800',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-default-wait-owner');
    expect(!(await call(owner, 'list_pages')).isError, 'Default-wait owner did not acquire the lease.');
    expect(!(await call(owner, 'select_page')).isError, 'Default-wait owner could not select a page.');

    const defaultClient = await connectGateway(fixture, 'gateway-default-wait-candidate');
    const defaultStarted = Date.now();
    const defaultBusy = await call(defaultClient, 'list_pages');
    const defaultElapsed = Date.now() - defaultStarted;
    expectError(defaultBusy, 'lease_busy', 'The default gateway did not return authenticated lease_busy.');
    expect(defaultElapsed >= 600 && defaultElapsed <= 1_250, `The default 750 ms lease wait took ${defaultElapsed} ms.`);
    expect(defaultBusy.structuredContent?.lease_state === 'held', 'The default gateway did not authenticate the owner.');
    expect(defaultBusy.structuredContent?.owner_pid === fixtureTransportPid(fixture, owner), 'The default busy result did not identify the owner.');
    expect(defaultBusy.structuredContent?.dispatched === false && defaultBusy.structuredContent?.automatic_retry_allowed === false, 'The default busy result permitted dispatch or automatic retry.');
    expect((await eventCount(events, 'list_pages')) === 1, 'The default lease timeout dispatched a Chrome tool.');
    const ownerAfterDefault = (await parsedDaemonStatus(fixture.root)).lease;
    expect(ownerAfterDefault?.pid === fixtureTransportPid(fixture, owner), 'The default status-only client yielded an idle owner.');

    const boundedWaiter = await connectGateway(fixture, 'gateway-explicit-timeout-candidate', { leaseWaitMs: 900 });
    const slow = call(owner, 'take_snapshot');
    await waitForCondition(async () => (await eventCount(events, 'take_snapshot')) === 1, 2_000, 'The timeout test owner tool did not start.');
    const queuedBusy = await call(boundedWaiter, 'list_pages');
    expectError(queuedBusy, 'lease_busy', 'The bounded queue timeout did not return lease_busy.');
    expect(queuedBusy.structuredContent?.dispatched === false && queuedBusy.structuredContent?.automatic_retry_allowed === false, 'The bounded queue timeout permitted dispatch or automatic retry.');
    expect((await eventCount(events, 'list_pages')) === 1, 'The bounded queue timeout dispatched a Chrome tool.');
    expect(!(await slow).isError, 'The timeout test owner tool failed.');
    await delay(250);
    expect((await parsedDaemonStatus(fixture.root)).lease?.pid === fixtureTransportPid(fixture, owner), 'A timed-out waiter released the owner later.');

    const canceledWaiter = await connectGateway(fixture, 'gateway-explicit-canceled-candidate', { leaseWaitMs: 5_000 });
    const secondSlow = call(owner, 'take_snapshot');
    await waitForCondition(async () => (await eventCount(events, 'take_snapshot')) === 2, 2_000, 'The cancellation test owner tool did not start.');
    const controller = new AbortController();
    const canceledCall = callWithOptions(canceledWaiter, 'list_pages', {}, { signal: controller.signal, timeout: 5_000 });
    await delay(125);
    controller.abort();
    let canceled = false;
    try { await canceledCall; } catch (cause) { canceled = cause?.name === 'AbortError' || String(cause?.message).toLowerCase().includes('abort'); }
    expect(canceled, 'The explicit waiter call did not observe cancellation.');
    expect(!(await secondSlow).isError, 'The cancellation test owner tool failed.');
    await delay(250);
    expect((await parsedDaemonStatus(fixture.root)).lease?.pid === fixtureTransportPid(fixture, owner), 'A canceled waiter released the owner later.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function canceledCommittedYieldCompletesBoundedTakeover() {
  const events = join(tmpdir(), `chrome-bridge-committed-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('committed-cancel', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS: '850',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_COMMIT_MS: '1500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  const sockets = new Set();
  const scriptedOwner = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let phase = 'request';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (phase === 'request' && request.operation === 'status' && request.token === 'a'.repeat(64)) {
        socket.end(`${JSON.stringify({
          pid: process.pid,
          parent_pid: process.ppid,
          gateway_instance_id: 'scripted-owner-gateway',
          lease_instance_id: 'scripted-owner-lease',
          acquired_at_utc: new Date().toISOString(),
          last_activity_at_utc: new Date().toISOString(),
          in_flight: false,
          queue_depth: 0,
        })}\n`);
        return;
      }
      if (phase === 'request'
        && request.operation === 'yield'
        && request.token === 'a'.repeat(64)
        && request.gateway_instance_id === 'scripted-owner-gateway'
        && request.lease_instance_id === 'scripted-owner-lease') {
        phase = 'ack';
        setTimeout(() => socket.write(`${JSON.stringify({
          operation: 'yield',
          accepted: true,
          gateway_instance_id: 'scripted-owner-gateway',
          lease_instance_id: 'scripted-owner-lease',
          reason: 'accepted',
        })}\n`), 700);
        return;
      }
      if (phase === 'ack'
        && request.operation === 'yield_ack'
        && request.token === 'a'.repeat(64)
        && request.gateway_instance_id === 'scripted-owner-gateway'
        && request.lease_instance_id === 'scripted-owner-lease') {
        phase = 'done';
        resolveAckReceived();
        setTimeout(() => {
          socket.end();
          scriptedOwner.close(() => resolveOwnerClosed());
        }, 350);
        return;
      }
      socket.destroy();
    });
  });
  let resolveAckReceived;
  let resolveOwnerClosed;
  const ackReceived = new Promise((resolveAck) => { resolveAckReceived = resolveAck; });
  const ownerClosed = new Promise((resolveClose) => { resolveOwnerClosed = resolveClose; });
  try {
    await new Promise((resolveListen, rejectListen) => {
      scriptedOwner.once('error', rejectListen);
      scriptedOwner.once('listening', resolveListen);
      scriptedOwner.listen(leasePipeFor(fixture.root));
    });
    const waiter = await connectGateway(fixture, 'gateway-committed-cancel-waiter', { leaseWaitMs: 900 });
    const controller = new AbortController();
    const started = Date.now();
    const canceledCall = callWithOptions(waiter, 'list_pages', {}, { signal: controller.signal, timeout: 5_000 });
    await withTimeout(ackReceived, 1_500, 'The scripted owner did not receive the committed yield ACK.');
    const ackElapsed = Date.now() - started;
    expect(ackElapsed >= 600 && ackElapsed < 900, `The ACK did not arrive just before the original 900 ms acquisition deadline: ${ackElapsed} ms.`);
    controller.abort();
    let canceled = false;
    try { await canceledCall; } catch (cause) { canceled = cause?.name === 'AbortError' || String(cause?.message).toLowerCase().includes('abort'); }
    expect(canceled, 'The MCP caller did not observe cancellation after ACK commit.');
    await withTimeout(ownerClosed, 2_000, 'The scripted owner did not finish its delayed close.');
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 3_000, 'The canceled committed handoff did not acquire and promptly release the lease.');
    expect((await eventCount(events, 'list_pages')) === 0, 'The canceled committed handoff dispatched a Chrome tool.');

    const sentinel = await connectGateway(fixture, 'gateway-committed-cancel-sentinel');
    expect(!(await call(sentinel, 'list_pages')).isError, 'A client could not acquire after the canceled committed handoff.');
    const sentinelLease = (await parsedDaemonStatus(fixture.root)).lease;
    await delay(400);
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === sentinelLease.lease_instance_id, 'A delayed canceled handoff released the later sentinel lease.');
    expect((await eventCount(events, 'list_pages')) === 1, 'The committed cancellation test dispatched an unexpected Chrome call.');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (scriptedOwner.listening) await new Promise((resolveClose) => scriptedOwner.close(resolveClose));
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function canceledNewBindReleasesOnlyThatLease() {
  const events = join(tmpdir(), `chrome-bridge-bind-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('bind-cancel', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_BEFORE_DISPATCH_DELAY_MS: '500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const client = await connectGateway(fixture, 'gateway-bind-cancel-client');
    const controller = new AbortController();
    const canceledCall = callWithOptions(client, 'list_pages', {}, { signal: controller.signal, timeout: 5_000 });
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.pid === fixtureTransportPid(fixture, client), 1_500, 'The cancellation test did not observe the new lease before dispatch.');
    controller.abort();
    let canceled = false;
    try { await canceledCall; } catch (cause) { canceled = cause?.name === 'AbortError' || String(cause?.message).toLowerCase().includes('abort'); }
    expect(canceled, 'The call canceled after lease bind did not reject at the MCP caller.');
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 1_500, 'A canceled new bind retained its unused lease.');
    expect((await eventCount(events, 'list_pages')) === 0, 'A call canceled after bind reached Chrome.');

    expect(!(await call(client, 'list_pages')).isError, 'The client could not acquire after its canceled new bind.');
    const existingLease = (await parsedDaemonStatus(fixture.root)).lease;
    const existingController = new AbortController();
    const canceledExistingCall = callWithOptions(client, 'list_pages', {}, { signal: existingController.signal, timeout: 5_000 });
    await delay(100);
    existingController.abort();
    try { await canceledExistingCall; } catch { }
    await delay(550);
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === existingLease.lease_instance_id, 'Cancellation released a pre-existing lease held by the same gateway.');
    expect((await eventCount(events, 'list_pages')) === 1, 'The pre-existing-lease cancellation dispatched a Chrome tool.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function ownerShutdownDuringPendingYieldReleasesNormally() {
  const fixture = await createFixture('pending-yield-shutdown', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '60',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS: '800',
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-pending-shutdown-owner');
    expect(!(await call(owner, 'list_pages')).isError, 'Pending-shutdown owner did not acquire the lease.');
    await delay(90);
    const original = await rawLeaseStatus(fixture.root);
    const pending = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    });
    expect((await pending.response)?.accepted === true, 'The shutdown test did not enter a pending yield.');
    const pendingClosed = once(pending.socket, 'close');
    await closeGateway(fixture, owner);
    await withTimeout(pendingClosed, 2_000, 'Owner shutdown did not close the pending yield socket.');
    await waitForCondition(() => leasePipeIsBindable(fixture.root), 2_000, 'Owner shutdown did not release the pending lease through normal shutdown.');

    const next = await connectGateway(fixture, 'gateway-after-pending-shutdown');
    expect(!(await call(next, 'list_pages')).isError, 'A new gateway could not acquire after pending-yield owner shutdown.');
  } finally {
    await closeFixture(fixture);
  }
}

async function committedAckStalledPeerStillReleases() {
  const fixture = await createFixture('stalled-yield-peer', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '60',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS: '800',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_OWNER_CLOSE_MS: '250',
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-stalled-yield-owner');
    expect(!(await call(owner, 'list_pages')).isError, 'Stalled-peer owner did not acquire the lease.');
    await delay(90);
    const original = await rawLeaseStatus(fixture.root);
    const stalled = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    }, 1_000, { allowHalfOpen: true });
    expect((await stalled.response)?.accepted === true, 'The stalled-peer test did not receive an accepted yield.');
    stalled.socket.write(`${JSON.stringify({
      operation: 'yield_ack',
      token: 'a'.repeat(64),
      gateway_instance_id: original.gateway_instance_id,
      lease_instance_id: original.lease_instance_id,
    })}\n`);
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 1_500, 'A valid committed ACK with a stalled peer did not release the lease.');
    stalled.socket.destroy();
  } finally {
    await closeFixture(fixture);
  }
}

async function cooperativeWaitersKeepMcpControlResponsive() {
  const events = join(tmpdir(), `chrome-bridge-cooperative-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const intervals = `${events}.intervals`;
  const fixture = await createFixture('cooperative-wait', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    FAKE_CHROME_DELAY_TOOL: 'take_snapshot',
    FAKE_CHROME_DELAY_MS: '150',
    FAKE_CHROME_EVENTS_FILE: events,
    FAKE_CHROME_INTERVALS_FILE: intervals,
  });
  const clients = [];
  let flows = [];
  try {
    const owner = await connectGateway(fixture, 'gateway-cooperative-owner');
    clients.push(owner);
    const completeSequence = async (client, label) => {
      expectError(await call(client, 'take_snapshot'), 'blocked_discovery_required', `${label} did not require list_pages first.`);
      const listed = await call(client, 'list_pages');
      expect(!listed.isError, `${label} list_pages failed: ${textOf(listed)} stderr=${fixture.stderrByClient.get(client)?.() ?? ''}`);
      expectError(await call(client, 'take_snapshot'), 'blocked_selection_required', `${label} did not require select_page before its target tool.`);
      expect(!(await call(client, 'select_page')).isError, `${label} select_page failed.`);
      expect(!(await call(client, 'take_snapshot')).isError, `${label} target tool failed.`);
      return label;
    };
    expect(await completeSequence(owner, 'owner') === 'owner', 'The owner sequence did not complete.');

    const initializeStarted = Date.now();
    const waiters = await Promise.all([
      connectGateway(fixture, 'gateway-cooperative-waiter-a', { leaseWaitMs: 10_000 }),
      connectGateway(fixture, 'gateway-cooperative-waiter-b', { leaseWaitMs: 10_000 }),
    ]);
    clients.push(...waiters);
    expect(Date.now() - initializeStarted <= 2_500, 'Cooperative waiter initialization waited for the browser lease.');

    const settled = [false, false];
    flows = waiters.map((client, index) => completeSequence(client, `waiter-${index + 1}`).finally(() => { settled[index] = true; }));
    await delay(150);
    const interimLease = (await parsedDaemonStatus(fixture.root)).lease;
    if (interimLease?.pid === fixtureTransportPid(fixture, owner)) {
      expect(settled.every((value) => value === false), 'A waiter completed while the authenticated owner still held the lease.');
      expect((await eventCount(events, 'list_pages')) === 1, 'A cooperative waiter dispatched list_pages while the owner held the lease.');
    }

    const toolsStarted = Date.now();
    const toolLists = await withTimeout(Promise.all(waiters.map((client) => client.listTools())), 1_500, 'tools/list was blocked behind cooperative lease waiting.');
    expect(Date.now() - toolsStarted <= 1_500, 'tools/list exceeded its normal bound during cooperative lease waiting.');
    expect(toolLists.every((result) => result.tools.length === 30), 'A cooperative waiter received an incomplete tool manifest.');

    const firstLabel = await withTimeout(Promise.race(flows), 15_000, 'No cooperative waiter completed within its 10-second acquisition bound.');
    const firstIndex = firstLabel === 'waiter-1' ? 0 : 1;
    const secondIndex = firstIndex === 0 ? 1 : 0;
    expect((await parsedDaemonStatus(fixture.root)).lease?.pid !== fixtureTransportPid(fixture, owner), 'The first idle waiter did not yield the live owner.');
    expect(await withTimeout(flows[secondIndex], 15_000, 'The second cooperative waiter did not complete within its 10-second acquisition bound.') === `waiter-${secondIndex + 1}`, 'The second waiter returned the wrong completion identity.');

    const dispatched = await readJsonLines(events);
    const expectedOrder = ['list_pages', 'select_page', 'take_snapshot', 'list_pages', 'select_page', 'take_snapshot', 'list_pages', 'select_page', 'take_snapshot'];
    expect(dispatched.length === expectedOrder.length && dispatched.every((entry, index) => entry.name === expectedOrder[index]), 'The three client sessions did not dispatch the required discovery-selection-target sequence.');
    const timing = await readJsonLines(intervals);
    expect(timing.length === expectedOrder.length * 2, 'The fake backend did not record a complete dispatch interval for each tool.');
    expect(timing.every((entry) => (entry.phase === 'start' && entry.active_calls === 1) || (entry.phase === 'end' && entry.active_calls === 0)), 'Fake backend Chrome tool dispatch overlapped between gateways.');
  } finally {
    const settledFlows = Promise.allSettled(flows);
    for (const client of clients) await closeGateway(fixture, client);
    await settledFlows;
    await closeFixture(fixture);
    await rm(events, { force: true });
    await rm(intervals, { force: true });
  }
}

async function yieldGraceProtectsPageFlowGaps() {
  const events = join(tmpdir(), `chrome-bridge-yield-grace-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('yield-grace', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '250',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-yield-grace-owner');
    const waiter = await connectGateway(fixture, 'gateway-yield-grace-waiter', { leaseWaitMs: 5_000 });
    expect(!(await call(owner, 'list_pages')).isError, 'Yield-grace owner list_pages failed.');
    const waiterStarted = Date.now();
    const waitingList = call(waiter, 'list_pages');
    await delay(75);
    expect(!(await call(owner, 'select_page')).isError, 'The quiet grace did not protect the list_pages to select_page gap.');
    await delay(75);
    expect(!(await call(owner, 'take_snapshot')).isError, 'The quiet grace did not protect the select_page to target gap.');
    const beforeYield = await readJsonLines(events);
    expect(beforeYield.length === 3 && beforeYield.map((entry) => entry.name).join(',') === 'list_pages,select_page,take_snapshot', 'A waiter entered during the protected page-flow gaps.');
    expect(!(await withTimeout(waitingList, 3_000, 'The explicit waiter did not acquire soon after the owner became idle.')).isError, 'The explicit waiter list_pages failed after idle yield.');
    expect(Date.now() - waiterStarted < 1_500, 'The explicit idle waiter did not acquire quickly.');
    const afterYield = await readJsonLines(events);
    expect(afterYield.length === 4 && afterYield[3].name === 'list_pages', 'The idle waiter did not dispatch exactly after the owner flow.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function yieldAfterGraceRequiresOldOwnerRediscovery() {
  const events = join(tmpdir(), `chrome-bridge-yield-rediscovery-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('yield-rediscovery', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000',
    CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS: '80',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-yield-rediscovery-owner');
    const waiter = await connectGateway(fixture, 'gateway-yield-rediscovery-waiter', { leaseWaitMs: 5_000 });
    expect(!(await call(owner, 'list_pages')).isError, 'Old-owner recovery list_pages failed.');
    expect(!(await call(owner, 'select_page')).isError, 'Old-owner recovery select_page failed.');
    await delay(120);
    expect(!(await call(waiter, 'list_pages')).isError, 'The explicit waiter did not yield the owner after the quiet grace.');
    expectError(await call(owner, 'take_snapshot'), 'blocked_discovery_required', 'The yielded owner retained selected-page state.');
    expect((await eventCount(events, 'take_snapshot')) === 0, 'The yielded owner dispatched its old target call.');

    await closeGateway(fixture, waiter);
    expect(!(await call(owner, 'list_pages')).isError, 'The yielded owner could not reacquire with fresh list_pages.');
    expect(!(await call(owner, 'select_page')).isError, 'The yielded owner could not make a fresh page selection.');
    expect(!(await call(owner, 'take_snapshot')).isError, 'The yielded owner could not continue after fresh discovery and selection.');
    const dispatched = await readJsonLines(events);
    const expected = ['list_pages', 'select_page', 'list_pages', 'list_pages', 'select_page', 'take_snapshot'];
    expect(dispatched.length === expected.length && dispatched.every((entry, index) => entry.name === expected[index]), 'The yielded owner recovery sequence dispatched unexpected Chrome calls.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function transientStatusPipeFailureIsRetried() {
  const fixture = await createFixture('status-retry');
  try {
    const preload = join(repositoryRoot, 'tests', 'status-pipe-failure-preload.cjs');
    const marker = join(fixture.root, 'status-pipe-failures.log');
    const nodeOptions = [fixture.env.NODE_OPTIONS, `--require "${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ');
    const baseEnv = {
      ...fixture.env,
      NODE_OPTIONS: nodeOptions,
      CHROME_DEVTOOLS_MCP_TEST_STATUS_FAILURE_MARKER: marker,
    };

    const recovered = await statusScriptResult(fixture.root, {
      ...baseEnv,
      CHROME_DEVTOOLS_MCP_TEST_STATUS_FAILURE_MODE: 'once',
    });
    expect(
      recovered.exitCode === 0 && recovered.value.daemon?.status === 'running',
      `status.ps1 did not recover from a transient status-pipe connection failure: ${textOf({ exitCode: recovered.exitCode, value: recovered.value, stderr: recovered.stderr })}`,
    );
    expect((await readFile(marker, 'utf8')).trim().split(/\r?\n/).length === 1, 'The transient status-pipe failure was not injected exactly once.');

    await writeFile(marker, '', 'utf8');
    const unavailable = await statusScriptResult(fixture.root, {
      ...baseEnv,
      CHROME_DEVTOOLS_MCP_TEST_STATUS_FAILURE_MODE: 'always',
    });
    expect(unavailable.exitCode === 3, `Persistent status-pipe failure exited with ${unavailable.exitCode}.`);
    expect(unavailable.value.daemon?.status === 'unavailable' && unavailable.value.daemon.cause === 'daemon_unreachable', 'The final status-pipe failure did not preserve daemon_unreachable.');
    expect((await readFile(marker, 'utf8')).trim().split(/\r?\n/).length === 3, 'The status probe did not stop after three bounded attempts.');
  } finally {
    await closeFixture(fixture);
  }
}

async function absentDaemonHasSanitizedCause() {
  const fixture = await createFixture('daemon-absent');
  let gateway;
  try {
    await stopDaemon(fixture);
    const statusResult = await statusScriptResult(fixture.root);
    const status = statusResult.value;
    expect(statusResult.exitCode === 3, `Absent-daemon status exited with ${statusResult.exitCode}.`);
    expect(status.daemon?.ok === false && status.daemon.status === 'absent' && status.daemon.cause === 'daemon_absent', 'status.ps1 did not preserve the daemon_absent cause.');
    const statusText = textOf(status);
    expect(!statusText.includes('sahar-tacit-chrome-daemon-') && !statusText.includes('a'.repeat(64)), 'Absent daemon status leaked a pipe name or token.');

    gateway = spawn(process.execPath, [join(fixture.root, 'runtime', 'stdio-proxy.mjs'), 'chrome-devtools'], {
      cwd: fixture.root,
      env: fixture.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    gateway.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const [exitCode] = await waitForChildExit(gateway);
    expect(exitCode === 3, `Absent-daemon gateway exited with ${exitCode}.`);
    const lines = stderr.trim().split(/\r?\n/);
    expect(lines.length === 1, 'Absent-daemon gateway emitted more than one diagnostic line.');
    const failure = JSON.parse(lines[0]);
    expect(failure.status === 'startup_failed' && failure.cause === 'daemon_absent', 'Gateway startup did not expose daemon_absent.');
    expect(!stderr.includes(fixture.root) && !stderr.includes('sahar-tacit-chrome-daemon-') && !stderr.includes('a'.repeat(64)), 'Gateway startup leaked a path, pipe name, or token.');
  } finally {
    if (gateway?.exitCode === null) gateway.kill('SIGKILL');
    await closeFixture(fixture);
  }
}

async function statusScriptStateFailures() {
  const root = await mkdtemp(join(tmpdir(), 'chrome-bridge-status-state-'));
  try {
    await mkdir(join(root, 'runtime'), { recursive: true });
    await cp(join(repositoryRoot, 'runtime', 'status.ps1'), join(root, 'runtime', 'status.ps1'));

    const missingState = await statusScriptResult(root);
    expect(missingState.exitCode === 4, `Missing-state status exited with ${missingState.exitCode}.`);
    expect(missingState.value.schema_version === 2 && missingState.value.daemon?.status === 'not_installed' && missingState.value.daemon.cause === 'install_state_missing', 'Missing install state did not return its fixed status and cause.');
    expect(missingState.value.lease?.state === 'held_unknown', 'Missing install state did not fail closed for lease status.');

    const sensitiveMarker = 'PRIVATE_INVALID_STATE_MARKER';
    await writeFile(join(root, 'install-state.json'), `{not-json ${sensitiveMarker}`, 'utf8');
    const invalidState = await statusScriptResult(root);
    expect(invalidState.exitCode === 4, `Invalid-state status exited with ${invalidState.exitCode}.`);
    expect(invalidState.value.daemon?.status === 'invalid' && invalidState.value.daemon.cause === 'install_state_invalid', 'Invalid install state did not return its fixed status and cause.');
    expect(!invalidState.stdout.includes(sensitiveMarker), 'Invalid install state output exposed source state data.');

    await writeFile(join(root, 'install-state.json'), JSON.stringify({ install_root: root, daemon_token: 'a'.repeat(64), node_path: join(root, 'missing-node.exe') }), 'utf8');
    const missingNode = await statusScriptResult(root);
    expect(missingNode.exitCode === 4 && missingNode.value.daemon?.status === 'runtime_missing' && missingNode.value.daemon.cause === 'node_runtime_missing', 'Missing Node runtime did not return its fixed status and cause.');

    await writeFile(join(root, 'install-state.json'), JSON.stringify({ install_root: root, daemon_token: 'a'.repeat(64), node_path: process.execPath }), 'utf8');
    const missingDaemon = await statusScriptResult(root);
    expect(missingDaemon.exitCode === 4 && missingDaemon.value.daemon?.status === 'runtime_missing' && missingDaemon.value.daemon.cause === 'daemon_runtime_missing', 'Missing daemon runtime did not return its fixed status and cause.');
    expect(!textOf(missingDaemon.value).includes('a'.repeat(64)), 'Missing runtime status exposed the daemon token.');
  } finally {
    const tempBase = resolve(tmpdir());
    if (!resolve(root).startsWith(tempBase) || !basename(root).startsWith('chrome-bridge-status-state-')) throw new Error('Temporary status test cleanup path failed its guard.');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

async function installPreflightMatrix() {
  const freeFixture = await createFixture('preflight-free');
  try {
    const before = (await readdir(freeFixture.root)).sort();
    const result = await installPreflight(freeFixture.root);
    expect(result.exitCode === 0 && result.value.ok === true && result.value.cause === 'lease_free', 'Preflight did not accept a free lease.');
    expect(result.value.lease?.state === 'free' && result.value.gateway_state === 'absent', 'Free preflight returned the wrong state.');
    expect(!result.stdout.includes(freeFixture.root) && !result.stdout.includes('a'.repeat(64)), 'Free preflight leaked the install root or token.');
    expect(textOf(before) === textOf((await readdir(freeFixture.root)).sort()), 'Free preflight changed the target directory.');
  } finally {
    await closeFixture(freeFixture);
  }

  const heldFixture = await createFixture('preflight-held', { CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000' });
  try {
    const client = await connectGateway(heldFixture, 'gateway-preflight-held');
    expect(!(await call(client, 'list_pages')).isError, 'Known-owner preflight gateway did not acquire the lease.');
    const before = await parsedDaemonStatus(heldFixture.root);
    const result = await installPreflight(heldFixture.root);
    expect(result.exitCode === 3 && result.value.ok === false && result.value.cause === 'lease_held', 'Preflight did not refuse a known live owner.');
    expect(result.value.lease?.pid === fixtureTransportPid(heldFixture, client), 'Preflight did not report the approved owner PID.');
    expect(!result.stdout.includes(heldFixture.root) && !result.stdout.includes('a'.repeat(64)), 'Held preflight leaked the install root or token.');
    const after = await parsedDaemonStatus(heldFixture.root);
    expect(after.lease?.state === 'held' && after.lease.gateway_instance_id === before.lease.gateway_instance_id, 'Held preflight changed the lease owner.');
  } finally {
    await closeFixture(heldFixture);
  }

  const idleGatewayFixture = await createFixture('preflight-idle-gateway', { CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '150' });
  try {
    const client = await connectGateway(idleGatewayFixture, 'gateway-preflight-idle');
    expect(!(await call(client, 'list_pages')).isError, 'Idle preflight gateway did not acquire the lease.');
    await waitForCondition(async () => (await parsedDaemonStatus(idleGatewayFixture.root)).lease?.state === 'free', 2_000, 'Idle preflight lease did not release.');
    const result = await installPreflight(idleGatewayFixture.root);
    expect(result.exitCode === 3 && result.value.cause === 'live_gateway_present', 'Preflight accepted a live gateway that could reacquire the lease.');
    expect(result.value.lease?.state === 'free' && processIsLive(fixtureTransportPid(idleGatewayFixture, client)), 'Idle gateway preflight changed the gateway or lease.');
  } finally {
    await closeFixture(idleGatewayFixture);
  }

  const legacyFixture = await createFixture('preflight-legacy');
  const legacySockets = new Set();
  const legacyOwner = net.createServer((socket) => {
    legacySockets.add(socket);
    socket.once('close', () => legacySockets.delete(socket));
    socket.end('{"legacy":true}\n');
  });
  try {
    await writeFile(join(legacyFixture.root, 'install-state.json'), JSON.stringify({ install_root: legacyFixture.root, daemon_token: 'a'.repeat(64), node_path: process.execPath, package_version: '0.1.0' }), 'utf8');
    await new Promise((resolveListen, rejectListen) => {
      legacyOwner.once('error', rejectListen);
      legacyOwner.once('listening', resolveListen);
      legacyOwner.listen(leasePipeFor(legacyFixture.root));
    });
    const beforeEntries = (await readdir(legacyFixture.root)).sort();
    const beforeState = await readFile(join(legacyFixture.root, 'install-state.json'), 'utf8');
    const result = await installPreflight(legacyFixture.root);
    expect(result.exitCode === 3 && result.value.cause === 'lease_held_unknown' && result.value.lease?.state === 'held_unknown', 'Preflight did not fail closed for a legacy owner.');
    expect(!result.stdout.includes(legacyFixture.root) && !result.stdout.includes('a'.repeat(64)), 'Legacy preflight leaked the install root or token.');
    expect(result.value.instructions?.some((line) => line.includes('Finish or close')) && result.value.instructions?.some((line) => line.includes('Wait for the lease')), 'Blocked preflight omitted the manual migration steps.');
    expect(legacyOwner.listening, 'Preflight changed the legacy lease owner.');

    const codexHome = join(legacyFixture.root, 'must-not-exist');
    const installAttempt = await runPowerShellScript(installScript, ['-InstallRoot', legacyFixture.root, '-CodexHome', codexHome, '-SkipScheduledTask', '-SkipStart']);
    expect(installAttempt.exitCode !== 0 && installAttempt.stderr.includes('Install preflight refused the in-place update'), 'Installer did not refuse the legacy owner before update.');
    expect(installAttempt.stderr.includes('Finish or close all client sessions') && installAttempt.stderr.includes('Wait for the lease to become free'), 'Installer refusal omitted the manual migration steps.');
    expect(textOf(beforeEntries) === textOf((await readdir(legacyFixture.root)).sort()), 'Installer refusal changed the target directory.');
    expect(await readFile(join(legacyFixture.root, 'install-state.json'), 'utf8') === beforeState, 'Installer refusal changed install state.');
    expect(legacyOwner.listening, 'Installer refusal changed the legacy lease owner.');
  } finally {
    for (const socket of legacySockets) socket.destroy();
    await new Promise((resolveClose) => legacyOwner.close(resolveClose));
    await closeFixture(legacyFixture);
  }
}

async function stdinCloseAndShortSessionsReleaseLease() {
  const fixture = await createFixture('stdin-close');
  try {
    const first = await connectGateway(fixture, 'gateway-stdin-close');
    expect(!(await call(first, 'list_pages')).isError, 'Gateway did not acquire the lease before stdin close.');
    const firstPid = fixture.transportByClient.get(first).pid;
    const started = Date.now();
    await closeGateway(fixture, first);
    const elapsed = Date.now() - started;
    expect(elapsed <= 1_000, `Gateway needed ${elapsed} ms to exit after stdin close.`);
    await waitForProcessExit(firstPid);
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 'Normal stdin close did not release the lease.');

    const observedPids = [];
    for (let index = 0; index < 100; index += 1) {
      const client = await connectGateway(fixture, `gateway-short-${index}`);
      expect(!(await call(client, 'list_pages')).isError, `Short gateway ${index} did not acquire the lease.`);
      const pid = fixture.transportByClient.get(client).pid;
      observedPids.push(pid);
      await closeGateway(fixture, client);
      await waitForProcessExit(pid);
    }
    expect(observedPids.length === 100, 'The repeated-session test did not complete all 100 child exit checks.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 'Short sessions left the lease held.');
  } finally {
    await closeFixture(fixture);
  }
}

async function idleReleaseRequiresFreshDiscoveryAndSelection() {
  const fixture = await createFixture('idle-release', { CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '150' });
  try {
    const first = await connectGateway(fixture, 'gateway-idle-first');
    expect(!(await call(first, 'list_pages')).isError, 'Idle test list_pages failed.');
    expect(!(await call(first, 'select_page')).isError, 'Idle test select_page failed.');
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 2_000, 'Idle gateway did not release the lease.');
    expectError(await call(first, 'take_snapshot'), 'blocked_discovery_required', 'Idle release retained selected-page state.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 'A blocked post-idle call reacquired the lease.');

    const second = await connectGateway(fixture, 'gateway-idle-second');
    expect(!(await call(second, 'list_pages')).isError, 'Second gateway did not acquire the idle-released lease.');
    await closeGateway(fixture, second);
    expect(!(await call(first, 'list_pages')).isError, 'Original gateway did not reacquire with list_pages.');
    expectError(await call(first, 'take_snapshot'), 'blocked_selection_required', 'Original gateway did not require fresh selection.');
    expect(!(await call(first, 'select_page')).isError, 'Original gateway could not select after reacquisition.');
    expect(!(await call(first, 'take_snapshot')).isError, 'Original gateway did not resume after fresh discovery and selection.');
  } finally {
    await closeFixture(fixture);
  }
}

async function idleTimerDoesNotReleaseActiveOrQueuedTools() {
  const events = join(tmpdir(), `chrome-bridge-idle-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('idle-in-flight', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '120',
    CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '200',
    FAKE_CHROME_DELAY_TOOL: 'take_snapshot',
    FAKE_CHROME_DELAY_MS: '1500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const first = await connectGateway(fixture, 'gateway-idle-in-flight-first');
    const second = await connectGateway(fixture, 'gateway-idle-in-flight-second');
    expect(!(await call(first, 'list_pages')).isError, 'In-flight test list_pages failed.');
    expect(!(await call(first, 'select_page')).isError, 'In-flight test select_page failed.');
    const slow = call(first, 'take_snapshot');
    await waitForCondition(async () => (await eventCount(events, 'take_snapshot')) === 1, 2_000, 'Slow tool was not dispatched.');
    const queued = call(first, 'hover');
    await waitForCondition(async () => {
      const lease = (await parsedDaemonStatus(fixture.root)).lease;
      return lease?.state === 'held' && lease.in_flight === true && lease.queue_depth >= 1;
    }, 2_000, 'Lease status did not report the active and queued tools.');
    await delay(180);
    const held = await parsedDaemonStatus(fixture.root);
    expect(held.lease?.state === 'held' && held.lease.in_flight === true, 'Idle timer released an active tool.');
    const busyYield = beginRawLeaseControl(fixture.root, {
      operation: 'yield',
      token: 'a'.repeat(64),
      gateway_instance_id: held.lease.gateway_instance_id,
      lease_instance_id: held.lease.lease_instance_id,
    });
    const busyYieldReply = await busyYield.response;
    expect(busyYieldReply?.accepted === false && busyYieldReply.reason === 'owner_busy', 'An active or queued owner accepted a yield request.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.lease_instance_id === held.lease.lease_instance_id, 'A busy-owner yield request changed the lease.');
    expectError(await call(second, 'list_pages'), 'lease_busy', 'Second gateway entered while a tool was active.');
    expect(!(await slow).isError, 'Slow tool failed.');
    expect(!(await queued).isError, 'Queued tool failed.');
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 2_000, 'Lease did not release after the queue became idle.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function gatewayStartupBypassesInFlightChromeQueue() {
  const events = join(tmpdir(), `chrome-bridge-startup-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('startup-in-flight', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '200',
    FAKE_CHROME_DELAY_TOOL: 'take_snapshot',
    FAKE_CHROME_DELAY_MS: '6500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const first = await connectGateway(fixture, 'gateway-startup-in-flight-first');
    expect(!(await call(first, 'list_pages')).isError, 'Startup test list_pages failed.');
    expect(!(await call(first, 'select_page')).isError, 'Startup test select_page failed.');
    const slow = call(first, 'take_snapshot');
    await waitForCondition(async () => (await eventCount(events, 'take_snapshot')) === 1, 2_000, 'Startup test slow tool was not dispatched.');
    const queued = call(first, 'hover');
    await waitForCondition(async () => {
      const lease = (await parsedDaemonStatus(fixture.root)).lease;
      return lease?.state === 'held' && lease.in_flight === true && lease.queue_depth >= 1;
    }, 2_000, 'Startup test owner did not report its active and queued tools.');

    const startupStarted = Date.now();
    const second = await connectGateway(fixture, 'gateway-startup-in-flight-second');
    const startupElapsed = Date.now() - startupStarted;
    expect(startupElapsed <= 1_500, `Second gateway startup waited ${startupElapsed} ms for the Chrome queue.`);

    const busyStarted = Date.now();
    const busy = await call(second, 'list_pages');
    const busyElapsed = Date.now() - busyStarted;
    expectError(busy, 'lease_busy', 'Second gateway entered during the first gateway tool call.');
    expect(busyElapsed <= 1_000, `Busy result took ${busyElapsed} ms.`);
    expect(busy.structuredContent?.owner_pid === fixtureTransportPid(fixture, first), 'Busy result did not identify the active owner PID.');
    expect(busy.structuredContent?.in_flight === true && busy.structuredContent?.queue_depth >= 1, 'Busy result did not include the active owner queue facts.');
    expect((await eventCount(events, 'list_pages')) === 1, 'Second gateway dispatched list_pages to Chrome.');

    expect(!(await slow).isError, 'Startup test slow tool failed.');
    expect(!(await queued).isError, 'Startup test queued tool failed.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function daemonStopRejectsLaterQueuedTool() {
  const events = join(tmpdir(), `chrome-bridge-stop-gate-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('stop-gate', {
    FAKE_CHROME_DELAY_TOOL: 'take_snapshot',
    FAKE_CHROME_DELAY_MS: '1500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  try {
    const owner = await connectGateway(fixture, 'gateway-stop-gate-owner');
    expect(!(await call(owner, 'list_pages')).isError, 'Stop-gate list_pages failed.');
    expect(!(await call(owner, 'select_page')).isError, 'Stop-gate select_page failed.');
    const daemonStatus = await parsedDaemonStatus(fixture.root);
    const slow = call(owner, 'take_snapshot');
    await waitForCondition(async () => (await eventCount(events, 'take_snapshot')) === 1, 2_000, 'Stop-gate slow tool was not dispatched.');

    const stopRequest = beginRawDaemonRequest(fixture.root, { operation: 'stop', token: 'a'.repeat(64) });
    await stopRequest.sent;
    await delay(50);
    const laterToolRequest = beginRawDaemonRequest(fixture.root, {
      operation: 'callTool',
      token: 'a'.repeat(64),
      name: 'hover',
      args: {},
      expectedGeneration: daemonStatus.backend_generation,
      expectedInstanceId: daemonStatus.daemon_instance_id,
    });
    await laterToolRequest.sent;

    const [slowResult, stopResult, laterToolResult] = await Promise.all([slow, stopRequest.result, laterToolRequest.result]);
    expect(!slowResult.isError, 'The call before stop did not finish normally.');
    expect(stopResult.ok === true && stopResult.status === 'stopping' && stopResult.stop_after_response === true, 'Authenticated stop was not accepted.');
    expect(laterToolResult.ok === false && laterToolResult.status === 'shutting_down' && laterToolResult.dispatched === false, 'The later tool did not fail with a non-dispatched shutting_down result.');
    expect((await eventCount(events, 'hover')) === 0, 'A tool queued after stop was dispatched to the fake Chrome backend.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function heldUnknownAndStatusAreReadOnly() {
  const fixture = await createFixture('held-unknown', { CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '750' });
  const oldOwnerSockets = new Set();
  const oldOwner = net.createServer((socket) => {
    oldOwnerSockets.add(socket);
    socket.once('close', () => oldOwnerSockets.delete(socket));
    socket.end('{"old":true}\n');
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      oldOwner.once('error', rejectListen);
      oldOwner.once('listening', resolveListen);
      oldOwner.listen(leasePipeFor(fixture.root));
    });
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'held_unknown', 'Invalid lease owner was not reported as held_unknown.');
    const client = await connectGateway(fixture, 'gateway-held-unknown', { leaseWaitMs: 5_000 });
    const started = Date.now();
    const blocked = await call(client, 'list_pages');
    expectError(blocked, 'held_unknown', 'Gateway did not fail closed for an invalid lease owner.');
    expect(Date.now() - started <= 750, 'Invalid lease owner waited instead of failing immediately.');

    const scriptStatus = await parsedScriptStatus(fixture.root);
    expect(scriptStatus.daemon?.status === 'running', 'status.ps1 did not report daemon health separately.');
    expect(scriptStatus.lease?.state === 'held_unknown', 'status.ps1 did not report held_unknown separately.');
    expect(oldOwner.listening, 'Status inspection changed the lease owner.');
  } finally {
    for (const socket of oldOwnerSockets) socket.destroy();
    await new Promise((resolveClose) => oldOwner.close(resolveClose));
    await closeFixture(fixture);
  }

  const heldFixture = await createFixture('status-read-only', { CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '10000' });
  try {
    const client = await connectGateway(heldFixture, 'gateway-status-read-only');
    expect(!(await call(client, 'list_pages')).isError, 'Status test list_pages failed.');
    const before = (await parsedScriptStatus(heldFixture.root)).lease;
    await delay(50);
    const after = (await parsedScriptStatus(heldFixture.root)).lease;
    expect(before?.state === 'held' && after?.state === 'held', 'Status inspection changed lease state.');
    expect(before.last_activity_at_utc === after.last_activity_at_utc, 'Status inspection changed lease activity time.');
    expectError(await call(client, 'take_snapshot'), 'blocked_selection_required', 'Status inspection changed selected-page state.');
  } finally {
    await closeFixture(heldFixture);
  }
}

async function abruptParentDeathReleasesLease() {
  const fixture = await createFixture('parent-death', { CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS: '2000' });
  let helper;
  let proxyPid;
  try {
    helper = spawn(process.execPath, [parentHelper, fixture.root, 'idle'], { cwd: repositoryRoot, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await readChildJsonLine(helper);
    proxyPid = ready.proxy_pid;
    expect(ready.status === 'ready' && processIsLive(proxyPid), 'Parent helper did not start its gateway.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.pid === proxyPid, 'Parent helper did not own the lease.');
    const helperExit = once(helper, 'exit');
    helper.kill('SIGKILL');
    await helperExit;
    await waitForProcessExit(proxyPid);
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 'Abrupt parent death did not release the lease.');
    const next = await connectGateway(fixture, 'gateway-after-parent-death');
    expect(!(await call(next, 'list_pages')).isError, 'A new gateway could not acquire after parent death.');
  } finally {
    if (helper?.exitCode === null) helper.kill('SIGKILL');
    if (processIsLive(proxyPid)) process.kill(proxyPid, 'SIGKILL');
    await closeFixture(fixture);
  }
}

async function parentDeathDuringMutationDoesNotReplay() {
  const events = join(tmpdir(), `chrome-bridge-parent-mutation-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('parent-mutation', {
    CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS: '2000',
    FAKE_CHROME_DELAY_TOOL: 'click',
    FAKE_CHROME_DELAY_MS: '1500',
    FAKE_CHROME_EVENTS_FILE: events,
  });
  let helper;
  let proxyPid;
  try {
    helper = spawn(process.execPath, [parentHelper, fixture.root, 'mutation'], { cwd: repositoryRoot, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await readChildJsonLine(helper);
    proxyPid = ready.proxy_pid;
    await waitForCondition(async () => (await eventCount(events, 'click')) === 1, 2_000, 'Mutation was not dispatched once.');
    await waitForCondition(async () => {
      const lease = (await parsedDaemonStatus(fixture.root)).lease;
      return lease?.pid === proxyPid && lease.in_flight === true && lease.queue_depth >= 1;
    }, 2_000, 'The second mutation did not enter the gateway queue.');
    const helperExit = once(helper, 'exit');
    helper.kill('SIGKILL');
    await helperExit;
    await waitForProcessExit(proxyPid, 3_000);
    expect((await eventCount(events, 'click')) === 1, 'Parent death replayed the mutation.');
    expect((await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 'Mutation drain did not release the lease.');
    const next = await connectGateway(fixture, 'gateway-after-parent-mutation');
    expect(!(await call(next, 'list_pages')).isError, 'Fresh discovery failed after parent death during mutation.');
    expect(!(await call(next, 'select_page')).isError, 'Fresh selection failed after parent death during mutation.');
    expect((await eventCount(events, 'click')) === 1, 'Fresh recovery flow replayed the mutation.');
  } finally {
    if (helper?.exitCode === null) helper.kill('SIGKILL');
    if (processIsLive(proxyPid)) process.kill(proxyPid, 'SIGKILL');
    await closeFixture(fixture);
    await rm(events, { force: true });
  }
}

async function postDispatchFailureIsNotReplayed() {
  const events = join(tmpdir(), `chrome-bridge-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const fixture = await createFixture('post-dispatch', { FAKE_CHROME_EVENTS_FILE: events, FAKE_CHROME_FAIL_TOOL: 'click', FAKE_CHROME_FAIL_ONCE_MARKER: `${events}.once` });
  try {
    const client = await connectGateway(fixture, 'gateway-post-dispatch');
    expect(!(await call(client, 'list_pages')).isError, 'list_pages failed before injected failure.');
    expect(!(await call(client, 'select_page')).isError, 'select_page failed before injected failure.');
    expectError(await call(client, 'click'), 'indeterminate_mutating_call', 'A post-dispatch mutation failure was not reported as indeterminate.');
    expectError(await call(client, 'click'), 'blocked_discovery_required', 'The gateway did not reset state after a backend failure.');
    const lines = (await readFile(events, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines.filter((entry) => entry.name === 'click').length === 1, 'The gateway replayed an uncertain click.');
  } finally {
    await closeFixture(fixture);
    await rm(events, { force: true });
    await rm(`${events}.once`, { force: true });
  }
}

async function dispatchedListFailureEnablesRecoveryOnce() {
  const marker = join(tmpdir(), `chrome-bridge-list-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fixture = await createFixture('recovery-gate', {
    CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS: '150',
    FAKE_CHROME_FAIL_TOOL: 'list_pages',
    FAKE_CHROME_FAIL_ONCE_MARKER: marker,
  });
  try {
    const client = await connectGateway(fixture, 'gateway-recovery-gate');
    expectError(await call(client, 'list_pages'), 'backend_call_failed', 'A dispatched list_pages failure was not reported.' );
    const firstRecovery = await call(client, 'allow_remote_debugging');
    expect(firstRecovery?.isError === true && !textOf(firstRecovery).includes('blocked_not_eligible'), 'A dispatched first list_pages failure did not enable one recovery attempt.');
    await waitForCondition(async () => (await parsedDaemonStatus(fixture.root)).lease?.state === 'free', 2_000, 'The recovery test lease did not become idle.');
    expectError(await call(client, 'allow_remote_debugging'), 'blocked_not_eligible', 'Idle lease release reset the consumed recovery action.');
  } finally {
    await closeFixture(fixture);
    await rm(marker, { force: true });
  }
}

async function exactConnectionErrorEnablesRecoveryButOtherToolErrorsDoNot() {
  const connectionFixture = await createFixture('connection-error', { FAKE_CHROME_LIST_CONNECTION_ERROR: '1' });
  try {
    const client = await connectGateway(connectionFixture, 'gateway-connection-error');
    const result = await call(client, 'list_pages');
    expect(result?.isError === true && textOf(result).includes('Could not connect to Chrome.'), 'The test connection error was not returned.' );
    const recovery = await call(client, 'allow_remote_debugging');
    expect(recovery?.isError === true && !textOf(recovery).includes('blocked_not_eligible'), 'The exact first-call Chrome auto-connect error did not enable one recovery attempt.');
  } finally {
    await closeFixture(connectionFixture);
  }

  const toolErrorFixture = await createFixture('tool-error', { FAKE_CHROME_LIST_TOOL_ERROR: '1' });
  try {
    const client = await connectGateway(toolErrorFixture, 'gateway-tool-error');
    expect((await call(client, 'list_pages'))?.isError === true, 'The test list_pages tool error was not returned.');
    expectError(await call(client, 'allow_remote_debugging'), 'blocked_not_eligible', 'A non-connection list_pages tool error enabled recovery.');
  } finally {
    await closeFixture(toolErrorFixture);
  }
}

async function backendGenerationAndDaemonInstanceReset() {
  const marker = join(tmpdir(), `chrome-bridge-close-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fixture = await createFixture('generation', { FAKE_CHROME_CLOSE_AFTER_LIST: '1', FAKE_CHROME_CLOSE_ONCE_MARKER: marker });
  try {
    const client = await connectGateway(fixture, 'gateway-generation');
    expect(!(await call(client, 'list_pages')).isError, 'Initial list_pages failed.');
    expect(!(await call(client, 'select_page')).isError, 'Initial select_page failed.');
    await delay(250);
    expectError(await call(client, 'take_snapshot'), 'backend_disconnected', 'Backend restart did not block the old selected-page state.');
    expect(!(await call(client, 'list_pages')).isError, 'Fresh list_pages did not reconnect the backend.');
    expect(!(await call(client, 'select_page')).isError, 'Fresh select_page failed after backend restart.');
    expect(!(await call(client, 'take_snapshot')).isError, 'Mutation/read did not resume after fresh discovery and selection.');

    const firstStatus = fixture.daemons.at(-1).status;
    const gatewayPid = fixture.transportByClient.get(client).pid;
    const leaseBeforeRestart = (await parsedDaemonStatus(fixture.root)).lease;
    await stopDaemon(fixture);
    const stoppedStatusResult = await statusScriptResult(fixture.root);
    const stoppedStatus = stoppedStatusResult.value;
    expect(stoppedStatusResult.exitCode === 3, `Stopped-daemon status exited with ${stoppedStatusResult.exitCode}.`);
    expect(stoppedStatus.daemon?.status === 'absent' && stoppedStatus.daemon.cause === 'daemon_absent', 'status.ps1 did not report the absent daemon cause.');
    expect(stoppedStatus.lease?.state === 'held' && stoppedStatus.lease.pid === gatewayPid, 'Daemon shutdown changed or hid the live gateway lease.');
    const secondStatus = await startDaemon(fixture, firstStatus.daemon_instance_id);
    expect(secondStatus.daemon_instance_id !== firstStatus.daemon_instance_id, 'Daemon restart reused its instance identifier.');
    const leaseAfterRestart = (await parsedDaemonStatus(fixture.root)).lease;
    expect(processIsLive(gatewayPid), 'Daemon restart terminated the live gateway.');
    expect(leaseAfterRestart?.state === 'held' && leaseAfterRestart.pid === gatewayPid, 'Daemon restart removed the live gateway lease.');
    expect(leaseAfterRestart.gateway_instance_id === leaseBeforeRestart.gateway_instance_id, 'Daemon restart changed the gateway instance.');
    expectError(await call(client, 'take_snapshot'), 'stale_backend_generation', 'A new daemon accepted old selected-page state.');
    expect(!(await call(client, 'list_pages')).isError, 'Fresh list_pages failed after daemon restart.');
    expect(!(await call(client, 'select_page')).isError, 'Fresh select_page failed after daemon restart.');
    expect(!(await call(client, 'take_snapshot')).isError, 'Old daemon instance state was not cleared before a fresh flow.');
  } finally {
    await closeFixture(fixture);
    await rm(marker, { force: true });
  }
}

if (process.env.CHROME_DEVTOOLS_MCP_TEST_FOCUS === 'cooperative-yield') {
  await cooperativeWaitersKeepMcpControlResponsive();
  process.stdout.write('Focused cooperative-yield test passed.\n');
  process.exit(0);
}

if (process.env.CHROME_DEVTOOLS_MCP_TEST_FOCUS === 'yield-races') {
  await authenticatedIdleYieldHandshake();
  await canceledCommittedYieldCompletesBoundedTakeover();
  await canceledNewBindReleasesOnlyThatLease();
  await ownerShutdownDuringPendingYieldReleasesNormally();
  await committedAckStalledPeerStillReleases();
  await yieldAfterGraceRequiresOldOwnerRediscovery();
  process.stdout.write('Focused yield-races tests passed.\n');
  process.exit(0);
}

if (process.env.CHROME_DEVTOOLS_MCP_TEST_FOCUS === 'default-wait') {
  await defaultGatewayIsFailFastAndQueueTimeoutDispatchesNothing();
  process.stdout.write('Focused default-wait test passed.\n');
  process.exit(0);
}

await normalFlowAndInvalidList();
await transientStatusPipeFailureIsRetried();
await statusScriptStateFailures();
await absentDaemonHasSanitizedCause();
await installPreflightMatrix();
await taskLease();
await authenticatedIdleYieldHandshake();
await defaultGatewayIsFailFastAndQueueTimeoutDispatchesNothing();
await canceledCommittedYieldCompletesBoundedTakeover();
await canceledNewBindReleasesOnlyThatLease();
await ownerShutdownDuringPendingYieldReleasesNormally();
await committedAckStalledPeerStillReleases();
await cooperativeWaitersKeepMcpControlResponsive();
await yieldGraceProtectsPageFlowGaps();
await yieldAfterGraceRequiresOldOwnerRediscovery();
await stdinCloseAndShortSessionsReleaseLease();
await idleReleaseRequiresFreshDiscoveryAndSelection();
await idleTimerDoesNotReleaseActiveOrQueuedTools();
await gatewayStartupBypassesInFlightChromeQueue();
await daemonStopRejectsLaterQueuedTool();
await heldUnknownAndStatusAreReadOnly();
await abruptParentDeathReleasesLease();
await parentDeathDuringMutationDoesNotReplay();
await postDispatchFailureIsNotReplayed();
await dispatchedListFailureEnablesRecoveryOnce();
await exactConnectionErrorEnablesRecoveryButOtherToolErrorsDoNot();
await backendGenerationAndDaemonInstanceReset();
process.stdout.write('Gateway daemon integration tests passed.\n');

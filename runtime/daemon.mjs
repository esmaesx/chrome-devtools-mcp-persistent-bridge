#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expectedTools = new Set([
  'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form',
  'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
  'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
  'resize_page', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot',
  'type_text', 'upload_file', 'wait_for',
]);
const readOnlyControlOperations = new Set(['status', 'listTools']);
const longRunningTools = new Set([
  'lighthouse_audit', 'navigate_page', 'new_page', 'performance_start_trace',
  'performance_stop_trace', 'take_heapsnapshot', 'wait_for',
]);
const retryableStatusProbeErrors = new Set(['EBUSY', 'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE']);
const statusProbeAttempts = 3;
const statusProbeRetryDelayMs = 50;

const installRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const statePath = join(installRoot, 'install-state.json');
const rootHash = createHash('sha256').update(installRoot.toLowerCase()).digest('hex').slice(0, 24);
const pipe = `\\\\.\\pipe\\sahar-tacit-chrome-daemon-${rootHash}`;
const leasePipe = `\\\\.\\pipe\\sahar-tacit-chrome-control-${rootHash}`;
const productionBackendEntry = join(installRoot, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasNoArguments(value) {
  return value === undefined || (isPlainObject(value) && Object.keys(value).length === 0);
}

function timeoutFor(name) {
  if (name === 'list_pages') return 15_000;
  return longRunningTools.has(name) ? 120_000 : 60_000;
}

function error(status, detail, extra = {}) {
  return { ok: false, status, detail, ...extra, daemon_instance_id: daemonInstanceId, backend_generation: backendGeneration };
}

async function readState() {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new Error(`The daemon install state is unavailable: ${statePath}`);
  }
  if (!isPlainObject(state) || typeof state.daemon_token !== 'string' || state.daemon_token.length < 32) {
    throw new Error('The daemon install state does not contain a valid daemon token.');
  }
  if (typeof state.install_root === 'string' && resolve(state.install_root).toLowerCase() !== installRoot.toLowerCase()) {
    throw new Error('The daemon install state does not belong to this install root.');
  }
  return state;
}

const state = await readState();
const daemonToken = Buffer.from(state.daemon_token, 'utf8');
const daemonInstanceId = randomUUID();
let backendClient;
let backendTransport;
let backendGeneration = 0;
let backendManifest;
let backendManifestFingerprint;
let queue = Promise.resolve();
let stopping = false;
let daemonServer;
const daemonSockets = new Set();

function isAuthorized(value) {
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value, 'utf8');
  return candidate.length === daemonToken.length && timingSafeEqual(candidate, daemonToken);
}

function isValidHeldLeaseStatus(value) {
  if (!isPlainObject(value)) return false;
  const expectedKeys = [
    'acquired_at_utc', 'gateway_instance_id', 'in_flight', 'last_activity_at_utc',
    'lease_instance_id', 'parent_pid', 'pid', 'queue_depth',
  ];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isSafeInteger(value.parent_pid) && value.parent_pid >= 0
    && typeof value.gateway_instance_id === 'string' && value.gateway_instance_id.length > 0
    && typeof value.lease_instance_id === 'string' && value.lease_instance_id.length > 0
    && Number.isFinite(Date.parse(value.acquired_at_utc))
    && Number.isFinite(Date.parse(value.last_activity_at_utc))
    && typeof value.in_flight === 'boolean'
    && Number.isSafeInteger(value.queue_depth) && value.queue_depth >= 0;
}

function probeLeaseStatus(timeout = 400) {
  return new Promise((resolveStatus) => {
    const socket = net.createConnection(leasePipe);
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveStatus(value);
    };
    const timer = setTimeout(() => finish({ state: 'held_unknown' }), timeout);
    socket.setEncoding('utf8');
    socket.once('error', (cause) => finish(cause.code === 'ENOENT' ? { state: 'free' } : { state: 'held_unknown' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024) return finish({ state: 'held_unknown' });
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish({ state: 'held_unknown' }); }
      finish(isValidHeldLeaseStatus(response) ? { state: 'held', ...response } : { state: 'held_unknown' });
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'status', token: state.daemon_token })}\n`));
  });
}

function normalizedManifest(tools) {
  const seen = new Set();
  for (const tool of tools ?? []) {
    if (typeof tool?.name !== 'string' || !expectedTools.has(tool.name)) throw new Error(`The backend exposed an unreviewed tool: ${String(tool?.name)}.`);
    if (seen.has(tool.name)) throw new Error(`The backend exposed a duplicate tool: ${tool.name}.`);
    seen.add(tool.name);
  }
  const missing = [...expectedTools].filter((name) => !seen.has(name));
  if (missing.length > 0 || seen.size !== expectedTools.size) {
    throw new Error(`The pinned backend tool manifest changed. Missing: ${missing.join(', ') || 'none'}.`);
  }
  return (tools ?? [])
    .filter((tool) => expectedTools.has(tool.name))
    .map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function manifestFingerprint(manifest) {
  return JSON.stringify(manifest.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  })));
}

function clearBackend(transport) {
  if (transport && backendTransport !== transport) return;
  if (backendClient || backendTransport) {
    backendClient = undefined;
    backendTransport = undefined;
    backendGeneration += 1;
  }
}

function testBackendEntry() {
  if (process.env.NODE_ENV !== 'test' || process.env.CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND !== '1') return productionBackendEntry;
  const candidate = process.env.CHROME_DEVTOOLS_MCP_TEST_BACKEND;
  return typeof candidate === 'string' && candidate.length > 0 ? resolve(candidate) : productionBackendEntry;
}

async function connectBackend() {
  if (backendClient) return backendClient;
  const client = new Client({ name: 'chrome-devtools-persistent-daemon', version: '0.1.3' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [testBackendEntry(), '--autoConnect', '--no-usage-statistics', '--no-performance-crux'],
    cwd: installRoot,
    stderr: 'inherit',
    env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
  });
  transport.onclose = () => clearBackend(transport);
  client.onerror = () => undefined;
  try {
    await client.connect(transport);
    const manifest = normalizedManifest((await client.listTools()).tools);
    const fingerprint = manifestFingerprint(manifest);
    if (backendManifestFingerprint && backendManifestFingerprint !== fingerprint) {
      await transport.close();
      throw new Error('The pinned backend tool manifest changed after reconnect.');
    }
    backendManifestFingerprint ??= fingerprint;
    backendManifest = manifest;
    backendClient = client;
    backendTransport = transport;
    backendGeneration += 1;
    return client;
  } catch (cause) {
    clearBackend(transport);
    try { await transport.close(); } catch { }
    throw cause;
  }
}

async function callTool(request) {
  const { name, args, expectedGeneration, expectedInstanceId } = request;
  if (typeof name !== 'string' || !expectedTools.has(name) || !isPlainObject(args)) {
    return error('blocked_request', 'The daemon request is not an allowed Chrome tool request.', { dispatched: false });
  }
  if (name === 'list_pages' && !hasNoArguments(args)) {
    return error('blocked_arguments', 'list_pages accepts an empty argument object only.', { dispatched: false });
  }
  if (name !== 'list_pages') {
    if (!backendClient) return error('backend_disconnected', 'The backend is disconnected. Call list_pages with an empty argument object first.', { dispatched: false });
    if (typeof expectedInstanceId !== 'string' || expectedInstanceId !== daemonInstanceId || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== backendGeneration) {
      return error('stale_backend_generation', 'The Chrome backend generation changed. Call list_pages and select_page again.', { dispatched: false });
    }
  }
  let client;
  try {
    client = name === 'list_pages' ? await connectBackend() : backendClient;
  } catch (cause) {
    const status = String(cause.message).toLowerCase().includes('tool manifest changed') ? 'backend_manifest_changed' : 'backend_connect_failed';
    return error(status, `The Chrome backend did not connect: ${cause.message}`, { dispatched: false });
  }
  const dispatchedGeneration = backendGeneration;
  try {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutFor(name), resetTimeoutOnProgress: true, maxTotalTimeout: timeoutFor(name) },
    );
    return { ok: true, result, daemon_instance_id: daemonInstanceId, backend_generation: backendGeneration, dispatched: true };
  } catch (cause) {
    return error('backend_call_failed', `The Chrome backend call failed: ${cause.message}`, {
      dispatched: true,
      dispatched_generation: dispatchedGeneration,
      tool: name,
    });
  }
}

async function dispatch(request) {
  if (!isPlainObject(request) || !isAuthorized(request.token)) return { ok: false, status: 'unauthorized', detail: 'The daemon request was not authenticated.' };
  switch (request.operation) {
    case 'status':
      return {
        ok: true,
        status: 'running',
        pid: process.pid,
        install_root: installRoot,
        pipe,
        daemon_instance_id: daemonInstanceId,
        backend_connected: Boolean(backendClient),
        backend_generation: backendGeneration,
        lease: await probeLeaseStatus(),
      };
    case 'listTools':
      if (!backendManifest) return error('backend_manifest_unavailable', 'The reviewed backend manifest is unavailable.', { dispatched: false });
      return { ok: true, tools: backendManifest, daemon_instance_id: daemonInstanceId, backend_generation: backendGeneration };
    case 'callTool':
      if (stopping) return error('shutting_down', 'The daemon is shutting down. No Chrome tool was dispatched.', { dispatched: false });
      return callTool(request);
    case 'stop':
      if (stopping) return { ok: true, status: 'stopping', pid: process.pid };
      stopping = true;
      return { ok: true, status: 'stopping', pid: process.pid, stop_after_response: true };
    default:
      return error('blocked_operation', 'The daemon operation is not allowed.', { dispatched: false });
  }
}

function writeResponse(socket, value) {
  try { socket.end(`${JSON.stringify(value)}\n`); } catch { socket.destroy(); }
}

function serveConnection(socket) {
  daemonSockets.add(socket);
  socket.once('close', () => daemonSockets.delete(socket));
  let buffer = '';
  let answered = false;
  const fail = () => {
    if (!answered) {
      answered = true;
      writeResponse(socket, { ok: false, status: 'invalid_protocol', detail: 'The daemon accepts one JSON-lines request.' });
    }
  };
  socket.setEncoding('utf8');
  socket.setTimeout(130_000, () => socket.destroy());
  socket.on('data', (chunk) => {
    if (answered) return;
    buffer += chunk;
    if (buffer.length > 1024 * 1024) return fail();
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    if (buffer.slice(newline + 1).trim().length > 0 || line.length === 0) return fail();
    let request;
    try { request = JSON.parse(line); } catch { return fail(); }
    answered = true;
    const isReadOnlyControl = isPlainObject(request) && readOnlyControlOperations.has(request.operation);
    const rejectsBeforeChromeQueue = isPlainObject(request) && stopping && request.operation === 'callTool';
    const bypassesChromeQueue = isReadOnlyControl || rejectsBeforeChromeQueue;
    const operation = bypassesChromeQueue ? dispatch(request) : queue.then(() => dispatch(request));
    if (!bypassesChromeQueue) queue = operation.catch(() => undefined);
    operation.then((response) => {
      writeResponse(socket, response);
      if (response.stop_after_response === true) setTimeout(() => { void shutdown().finally(() => process.exit(0)); }, 0);
    }).catch(() => writeResponse(socket, error('internal_error', 'The daemon request failed before a result was produced.')));
  });
  socket.on('error', () => undefined);
}

async function shutdown() {
  if (!daemonServer) return;
  const server = daemonServer;
  daemonServer = undefined;
  const closeServer = new Promise((resolveClose) => server.close(resolveClose));
  for (const socket of daemonSockets) socket.destroy();
  try {
    const closeBackend = backendTransport?.close();
    if (closeBackend) await Promise.race([closeBackend, new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  } catch { }
  clearBackend();
  await closeServer;
}

function requestPipe(request, timeout = 5_000) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(pipe);
    let buffer = '';
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => settle(rejectRequest, new Error('The daemon pipe request timed out.')), timeout);
    socket.setEncoding('utf8');
    socket.once('error', (cause) => settle(rejectRequest, cause));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { settle(resolveRequest, JSON.parse(buffer.slice(0, newline))); } catch { settle(rejectRequest, new Error('The daemon returned invalid JSON.')); }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...request, token: state.daemon_token })}\n`));
  });
}

function sanitizedDaemonFailure(cause) {
  if (cause?.code === 'ENOENT') return { ok: false, status: 'absent', cause: 'daemon_absent' };
  if (cause?.message === 'The daemon pipe request timed out.') return { ok: false, status: 'unresponsive', cause: 'daemon_timeout' };
  return { ok: false, status: 'unavailable', cause: 'daemon_unreachable' };
}

async function requestDaemonStatus() {
  let lastCause;
  for (let attempt = 1; attempt <= statusProbeAttempts; attempt += 1) {
    try {
      return await requestPipe({ operation: 'status' });
    } catch (cause) {
      lastCause = cause;
      if (attempt === statusProbeAttempts || !retryableStatusProbeErrors.has(cause?.code)) throw cause;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, statusProbeRetryDelayMs));
    }
  }
  throw lastCause;
}

async function clientMode(argument) {
  if (argument === '--lease-status') {
    process.stdout.write(`${JSON.stringify(await probeLeaseStatus())}\n`);
    return;
  }
  if (argument === '--status') {
    let response;
    try {
      response = await requestDaemonStatus();
    } catch (cause) {
      process.stdout.write(`${JSON.stringify(sanitizedDaemonFailure(cause))}\n`);
      process.exitCode = 3;
      return;
    }
    if (!response?.ok || response.status !== 'running') {
      process.stdout.write(`${JSON.stringify({ ok: false, status: 'invalid', cause: 'daemon_invalid_status' })}\n`);
      process.exitCode = 3;
      return;
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  if (argument !== '--stop') throw new Error('Usage: daemon.mjs [--status|--lease-status|--stop]');
  const prior = await requestPipe({ operation: 'status' });
  if (!prior.ok || prior.status !== 'running' || !Number.isSafeInteger(prior.pid)) throw new Error(prior.detail || 'The daemon is unavailable.');
  const requested = await requestPipe({ operation: 'stop' });
  if (!requested.ok) throw new Error(requested.detail || 'The daemon did not accept the stop request.');
  const deadline = Date.now() + 10_000;
  let stopped = false;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    try {
      const live = await requestPipe({ operation: 'status' }, 500);
      if (!live.ok || live.pid !== prior.pid) { stopped = true; break; }
    } catch {
      stopped = true;
      break;
    }
  }
  if (!stopped) throw new Error(`The exact daemon PID ${prior.pid} did not stop.`);
  process.stdout.write(`${JSON.stringify({ status: 'stopped', pid: prior.pid, install_root: installRoot, pipe })}\n`);
}

if (process.argv.length > 2) {
  try {
    await clientMode(process.argv[2]);
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  }
} else {
  await connectBackend();
  daemonServer = net.createServer(serveConnection);
  daemonServer.on('error', (cause) => {
    process.stderr.write(`Chrome daemon pipe error: ${cause.message}\n`);
    process.exitCode = 1;
  });
  await new Promise((resolveListen, rejectListen) => {
    daemonServer.once('error', rejectListen);
    daemonServer.once('listening', resolveListen);
    daemonServer.listen(pipe);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
  }
}

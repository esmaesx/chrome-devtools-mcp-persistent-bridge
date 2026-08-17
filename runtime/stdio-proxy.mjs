#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);
const expectedTools = new Set([
  'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form',
  'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
  'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
  'resize_page', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot',
  'type_text', 'upload_file', 'wait_for',
]);
const readOnlyTools = new Set([
  'get_console_message', 'list_console_messages', 'list_network_requests', 'list_pages',
  'performance_analyze_insight', 'wait_for',
]);

if (process.argv.length > 2 && process.argv[2] !== 'chrome-devtools') {
  process.stderr.write('This gateway exposes only the chrome-devtools server.\n');
  process.exit(2);
}

const installRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const statePath = join(installRoot, 'install-state.json');
const recoveryScript = fileURLToPath(new URL('./allow-remote-debugging.ps1', import.meta.url));
const rootHash = createHash('sha256').update(installRoot.toLowerCase()).digest('hex').slice(0, 24);
const daemonPipe = `\\\\.\\pipe\\dev-newb-chrome-daemon-${rootHash}`;
const leasePipe = `\\\\.\\pipe\\dev-newb-chrome-control-${rootHash}`;
const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const gatewayInstanceId = randomUUID();
const leaseWaitMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS ?? '')
  ? Math.min(750, Number(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS))
  : 750;
const leaseIdleMs = process.env.NODE_ENV === 'test' && /^\d{1,6}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS)
  : 10 * 60 * 1000;
const shutdownDrainMs = process.env.NODE_ENV === 'test' && /^\d{1,6}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS)
  : 130_000;

let daemonToken;
let leaseServer;
const leaseSockets = new Set();
let leaseAcquiredAt;
let lastLeaseActivityAt;
let leaseIdleTimer;
let recoveryEligible = false;
let recoveryConsumed = false;
let firstValidListPagesPending = true;
let pageState = 'need_list';
let backendGeneration;
let backendInstanceId;
let callQueue = Promise.resolve();
let queuedToolCount = 0;
let activeToolCount = 0;
let shuttingDown = false;
let shutdownPromise;
let exitScheduled = false;
let requestedExitCode = 0;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasNoArguments(value) {
  return value === undefined || (isPlainObject(value) && Object.keys(value).length === 0);
}

function errorResult(status, detail, extra = {}) {
  const value = { status, ...extra, detail };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

async function readDaemonToken() {
  let parsed;
  try { parsed = JSON.parse(await readFile(statePath, 'utf8')); } catch { throw new Error('The authenticated daemon install state is unavailable.'); }
  if (!isPlainObject(parsed) || typeof parsed.daemon_token !== 'string' || parsed.daemon_token.length < 32) throw new Error('The authenticated daemon token is missing from install state.');
  if (typeof parsed.install_root === 'string' && resolve(parsed.install_root).toLowerCase() !== installRoot.toLowerCase()) throw new Error('The daemon install state does not belong to this install root.');
  daemonToken = parsed.daemon_token;
}

function startupFailureCause(cause) {
  if (cause?.bridgeCause) return cause.bridgeCause;
  if (cause?.code === 'ENOENT') return 'daemon_absent';
  if (cause?.message === 'The daemon request timed out.') return 'daemon_timeout';
  if (cause?.message === 'The authenticated daemon install state is unavailable.' || cause?.message === 'The authenticated daemon token is missing from install state.' || cause?.message === 'The daemon install state does not belong to this install root.') return 'install_state_unavailable';
  return 'daemon_unreachable';
}

function exitForStartupFailure(cause) {
  process.stderr.write(`${JSON.stringify({
    schema_version: 1,
    component: 'chrome-devtools-persistent-gateway',
    status: 'startup_failed',
    cause: startupFailureCause(cause),
    retryable: true,
  })}\n`);
  process.exit(3);
}

function isAuthorizedLeaseStatus(value) {
  if (typeof value !== 'string' || typeof daemonToken !== 'string') return false;
  const expected = Buffer.from(daemonToken, 'utf8');
  const candidate = Buffer.from(value, 'utf8');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function leaseStatusSnapshot() {
  return {
    pid: process.pid,
    parent_pid: process.ppid,
    gateway_instance_id: gatewayInstanceId,
    acquired_at_utc: new Date(leaseAcquiredAt).toISOString(),
    last_activity_at_utc: new Date(lastLeaseActivityAt).toISOString(),
    in_flight: activeToolCount > 0,
    queue_depth: queuedToolCount,
  };
}

function serveLeaseStatus(socket, ownerServer) {
  leaseSockets.add(socket);
  socket.once('close', () => leaseSockets.delete(socket));
  socket.setEncoding('utf8');
  socket.setTimeout(500, () => socket.destroy());
  let buffer = '';
  let answered = false;
  socket.on('data', (chunk) => {
    if (answered) return;
    buffer += chunk;
    if (buffer.length > 4096) {
      answered = true;
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    answered = true;
    const line = buffer.slice(0, newline).trim();
    if (buffer.slice(newline + 1).trim().length > 0 || line.length === 0) {
      socket.destroy();
      return;
    }
    let request;
    try { request = JSON.parse(line); } catch { socket.destroy(); return; }
    if (!isPlainObject(request) || request.operation !== 'status' || !isAuthorizedLeaseStatus(request.token)) {
      socket.destroy();
      return;
    }
    if (leaseServer !== ownerServer || !Number.isFinite(leaseAcquiredAt) || !Number.isFinite(lastLeaseActivityAt)) {
      socket.destroy();
      return;
    }
    socket.end(`${JSON.stringify(leaseStatusSnapshot())}\n`);
  });
  socket.on('error', () => undefined);
}

function isValidHeldLeaseStatus(value) {
  if (!isPlainObject(value)) return false;
  const expectedKeys = [
    'acquired_at_utc', 'gateway_instance_id', 'in_flight', 'last_activity_at_utc',
    'parent_pid', 'pid', 'queue_depth',
  ];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isSafeInteger(value.parent_pid) && value.parent_pid >= 0
    && typeof value.gateway_instance_id === 'string' && value.gateway_instance_id.length > 0
    && Number.isFinite(Date.parse(value.acquired_at_utc))
    && Number.isFinite(Date.parse(value.last_activity_at_utc))
    && typeof value.in_flight === 'boolean'
    && Number.isSafeInteger(value.queue_depth) && value.queue_depth >= 0;
}

function readLeaseOwner(timeout) {
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
    socket.once('error', () => finish({ state: 'held_unknown' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024) return finish({ state: 'held_unknown' });
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish({ state: 'held_unknown' }); }
      finish(isValidHeldLeaseStatus(response) ? { state: 'held', ...response } : { state: 'held_unknown' });
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'status', token: daemonToken })}\n`));
  });
}

class LeaseBusyError extends Error {
  constructor(lease) {
    super(lease.state === 'held' ? 'The persistent Chrome bridge lease is held by another gateway.' : 'The persistent Chrome bridge lease is held by an unknown or older gateway.');
    this.name = 'LeaseBusyError';
    this.lease = lease;
  }
}

async function acquireTaskLease() {
  if (leaseServer) return;
  const deadline = Date.now() + leaseWaitMs;
  let observedOwner;
  while (Date.now() <= deadline) {
    try {
      const candidate = net.createServer((socket) => serveLeaseStatus(socket, candidate));
      await new Promise((resolveListen, rejectListen) => {
        const onError = (cause) => { candidate.removeListener('listening', onListening); rejectListen(cause); };
        const onListening = () => { candidate.removeListener('error', onError); resolveListen(); };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(leasePipe);
      });
      leaseServer = candidate;
      leaseAcquiredAt = Date.now();
      lastLeaseActivityAt = leaseAcquiredAt;
      return;
    } catch (cause) {
      if (cause.code !== 'EADDRINUSE') throw cause;
      const ownerTimeout = Math.max(25, Math.min(100, deadline - Date.now()));
      if (ownerTimeout > 0) observedOwner = await readLeaseOwner(ownerTimeout);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(25, remaining));
    }
  }
  throw new LeaseBusyError(observedOwner ?? { state: 'held_unknown' });
}

function clearIdleLeaseTimer() {
  if (!leaseIdleTimer) return;
  clearTimeout(leaseIdleTimer);
  leaseIdleTimer = undefined;
}

function clearLeaseScopedState() {
  pageState = 'need_list';
  backendGeneration = undefined;
  backendInstanceId = undefined;
  recoveryEligible = false;
}

async function releaseTaskLease({ resetState = true } = {}) {
  clearIdleLeaseTimer();
  if (!leaseServer) return;
  const server = leaseServer;
  leaseServer = undefined;
  leaseAcquiredAt = undefined;
  lastLeaseActivityAt = undefined;
  if (resetState) clearLeaseScopedState();
  for (const socket of leaseSockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
}

function armIdleLeaseRelease() {
  clearIdleLeaseTimer();
  if (!leaseServer || activeToolCount !== 0 || queuedToolCount !== 0 || shuttingDown) return;
  const expectedServer = leaseServer;
  leaseIdleTimer = setTimeout(() => {
    leaseIdleTimer = undefined;
    if (leaseServer !== expectedServer || activeToolCount !== 0 || queuedToolCount !== 0 || shuttingDown) return;
    void releaseTaskLease({ resetState: true });
  }, leaseIdleMs);
  leaseIdleTimer.unref?.();
}

function leaseBusyResult(cause, tool) {
  const lease = cause.lease?.state === 'held' ? cause.lease : { state: 'held_unknown' };
  if (lease.state === 'held') {
    return errorResult('lease_busy', 'The Chrome bridge lease is held by another live gateway. No Chrome tool was dispatched.', {
      tool,
      dispatched: false,
      retry_allowed: true,
      automatic_retry_allowed: false,
      lease_state: lease.state,
      owner_pid: lease.pid,
      owner_parent_pid: lease.parent_pid,
      owner_gateway_instance_id: lease.gateway_instance_id,
      acquired_at_utc: lease.acquired_at_utc,
      last_activity_at_utc: lease.last_activity_at_utc,
      in_flight: lease.in_flight,
      queue_depth: lease.queue_depth,
    });
  }
  return errorResult('held_unknown', 'The Chrome bridge lease is held by an older or invalid gateway that did not return authenticated owner status. No Chrome tool was dispatched.', {
    tool,
    dispatched: false,
    retry_allowed: true,
    automatic_retry_allowed: false,
    lease_state: 'held_unknown',
  });
}

function daemonRequest(operation, payload = {}, timeout = 130_000) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(daemonPipe);
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(rejectRequest, new Error('The daemon request timed out.')), timeout);
    socket.setEncoding('utf8');
    socket.once('error', (cause) => finish(rejectRequest, cause));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(rejectRequest, new Error('The daemon response was too large.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(resolveRequest, JSON.parse(buffer.slice(0, newline))); } catch { finish(rejectRequest, new Error('The daemon returned invalid JSON.')); }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation, token: daemonToken, ...payload })}\n`));
  });
}

function normalizedManifest(tools) {
  const seen = new Set();
  const manifest = [];
  for (const tool of tools ?? []) {
    if (typeof tool?.name !== 'string' || !expectedTools.has(tool.name)) throw new Error(`The daemon exposed an unreviewed tool: ${String(tool?.name)}.`);
    if (seen.has(tool.name)) throw new Error(`The daemon exposed a duplicate tool: ${tool.name}.`);
    seen.add(tool.name);
    manifest.push({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
  }
  const missing = [...expectedTools].filter((name) => !seen.has(name));
  if (missing.length > 0 || manifest.length !== expectedTools.size) throw new Error(`The daemon tool manifest changed. Missing: ${missing.join(', ') || 'none'}.`);
  return manifest.sort((left, right) => left.name.localeCompare(right.name));
}

function observeBackend(response) {
  const generation = response?.backend_generation;
  const instanceId = response?.daemon_instance_id;
  if (!Number.isSafeInteger(generation) || typeof instanceId !== 'string' || instanceId.length < 1) return;
  if ((backendGeneration !== undefined && backendGeneration !== generation) || (backendInstanceId !== undefined && backendInstanceId !== instanceId)) pageState = 'need_list';
  backendGeneration = generation;
  backendInstanceId = instanceId;
}

function isAutoConnectPermissionError(result) {
  if (result?.isError !== true || !Array.isArray(result.content) || result.content.length !== 1) return false;
  const item = result.content[0];
  if (item?.type !== 'text' || typeof item.text !== 'string') return false;
  const expected = 'Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.';
  return item.text === expected || item.text.startsWith(`${expected}\nCause: `);
}

async function invokeChromeTool(name, args) {
  const validListPages = name === 'list_pages' && hasNoArguments(args);
  if (name === 'list_pages' && !validListPages) return errorResult('blocked_arguments', 'list_pages accepts an empty argument object only.');
  if (name !== 'list_pages' && !isPlainObject(args)) return errorResult('blocked_arguments', 'Chrome tool arguments must be an object.');
  if (pageState === 'need_list' && name !== 'list_pages') return errorResult('blocked_discovery_required', 'Call list_pages before another Chrome tool in this task.');
  if (pageState === 'need_select' && name !== 'list_pages' && name !== 'select_page') return errorResult('blocked_selection_required', 'Call select_page after list_pages before another Chrome tool in this task.');
  try {
    await acquireTaskLease();
  } catch (cause) {
    if (cause instanceof LeaseBusyError) return leaseBusyResult(cause, name);
    throw cause;
  }

  const wasFirstCall = firstValidListPagesPending;
  if (name === 'list_pages') firstValidListPagesPending = false;
  const payload = { name, args: args ?? {} };
  if (name !== 'list_pages') {
    payload.expectedGeneration = backendGeneration;
    payload.expectedInstanceId = backendInstanceId;
  }
  let response;
  try {
    response = await daemonRequest('callTool', payload);
  } catch (cause) {
    pageState = 'need_list';
    return errorResult('backend_unavailable', `The local Chrome daemon did not return a result: ${cause.message}`, { tool: name, retry_allowed: false });
  }
  observeBackend(response);
  if (!response.ok) {
    pageState = 'need_list';
    if (response.status === 'backend_manifest_changed') {
      return errorResult('backend_manifest_changed', 'The backend tool manifest changed. The gateway failed closed.');
    }
    if (wasFirstCall && name === 'list_pages' && response.dispatched === true && response.status === 'backend_call_failed') recoveryEligible = true;
    const mutating = !readOnlyTools.has(name);
    return errorResult(
      mutating && response.dispatched ? 'indeterminate_mutating_call' : response.status || 'backend_call_failed',
      mutating && response.dispatched ? 'The Chrome call did not return a confirmed result. It may have completed. Do not replay it automatically.' : (response.detail || 'The Chrome backend call failed.'),
      { tool: name, retry_allowed: false, backend_generation: response.backend_generation, daemon_instance_id: response.daemon_instance_id },
    );
  }
  if (name === 'list_pages') {
    if (response.result?.isError === true) {
      pageState = 'need_list';
      if (wasFirstCall && isAutoConnectPermissionError(response.result)) recoveryEligible = true;
    }
    else {
      recoveryEligible = false;
      pageState = 'need_select';
    }
  } else if (name === 'select_page' && response.result?.isError !== true) {
    pageState = 'ready';
  }
  return response.result;
}

async function invokeRecovery(args) {
  if (!hasNoArguments(args)) return errorResult('blocked_arguments', 'The recovery action accepts no arguments.', { mutated: false });
  if (!recoveryEligible || recoveryConsumed) return errorResult('blocked_not_eligible', 'Recovery is available one time only after this task’s first dispatched list_pages call fails.', { mutated: false });
  try {
    await acquireTaskLease();
  } catch (cause) {
    if (cause instanceof LeaseBusyError) return leaseBusyResult(cause, 'allow_remote_debugging');
    throw cause;
  }
  recoveryConsumed = true;
  recoveryEligible = false;
  try {
    const { stdout } = await execFileAsync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', recoveryScript], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const value = JSON.parse(stdout.trim());
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value.status !== 'invoked_dialog_closed' };
  } catch (cause) {
    try {
      const value = JSON.parse(String(cause.stdout ?? '').trim());
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
    } catch {
      return errorResult('error', 'The narrow Chrome permission recovery process failed.', { mutated: false });
    }
  }
}

let manifestResponse;
try {
  await readDaemonToken();
  manifestResponse = await daemonRequest('listTools', {}, 5_000);
  if (!manifestResponse?.ok) {
    const cause = new Error('The reviewed daemon tool manifest is unavailable.');
    cause.bridgeCause = 'daemon_invalid_status';
    throw cause;
  }
} catch (cause) {
  exitForStartupFailure(cause);
}
observeBackend(manifestResponse);
const initialManifest = normalizedManifest(manifestResponse.tools);
const server = new Server(
  { name: 'chrome-devtools-persistent-gateway', version: '0.1.1' },
  { capabilities: { tools: {} }, instructions: 'One gateway owns the shared Chrome backend while its lease is active. An idle release clears page state. Discover and select a page before other tools.' },
);
const clientTools = [
  ...initialManifest,
  { name: 'allow_remote_debugging', title: 'Inspect and dismiss one verified native Chrome debugging dialog', description: 'Available one time only after this task’s first dispatched list_pages call fails. It invokes no coordinate or general desktop action.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: clientTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== 'allow_remote_debugging' && !expectedTools.has(name)) return errorResult('blocked_unknown_tool', 'The requested tool is not in the pinned gateway allowlist.');
  if (shuttingDown) return errorResult('gateway_shutting_down', 'The gateway parent transport closed. No new tool call was accepted.');
  clearIdleLeaseTimer();
  queuedToolCount += 1;
  const operation = callQueue.then(async () => {
    queuedToolCount -= 1;
    if (shuttingDown) return errorResult('gateway_shutting_down', 'The gateway parent transport closed. The queued tool was not dispatched.', { dispatched: false });
    activeToolCount += 1;
    try {
      return await (name === 'allow_remote_debugging' ? invokeRecovery(args) : invokeChromeTool(name, args));
    } finally {
      activeToolCount -= 1;
      if (leaseServer) lastLeaseActivityAt = Date.now();
      armIdleLeaseRelease();
    }
  });
  callQueue = operation.catch(() => undefined);
  return operation;
});

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  clearIdleLeaseTimer();
  shutdownPromise = (async () => {
    if (activeToolCount > 0 || queuedToolCount > 0) {
      await Promise.race([callQueue.catch(() => undefined), delay(shutdownDrainMs)]);
    }
    await releaseTaskLease({ resetState: true });
  })();
  return shutdownPromise;
}
function shutdownAndExit(exitCode = 0) {
  if (Number.isSafeInteger(exitCode)) requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (exitScheduled) return;
  exitScheduled = true;
  void shutdown().finally(() => process.exit(requestedExitCode));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdownAndExit(0));
const frontTransport = new StdioServerTransport();
frontTransport.onclose = () => shutdownAndExit(0);
process.stdin.once('end', () => shutdownAndExit(0));
process.stdin.once('close', () => shutdownAndExit(0));
process.stdin.once('error', () => shutdownAndExit(1));
process.once('uncaughtException', () => shutdownAndExit(1));
process.once('unhandledRejection', () => shutdownAndExit(1));
await server.connect(frontTransport);

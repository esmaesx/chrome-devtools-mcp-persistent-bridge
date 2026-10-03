#!/usr/bin/env node
import { prepareEndpoints, validatePrivateState } from './local-endpoints.mjs';

import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const usage = 'Usage: stdio-proxy.mjs chrome-devtools [--lease-wait-ms N]; N must be canonical ASCII digits from 750 through 300000.\n';

function parseGatewayArguments(args) {
  if (args.length === 1 && args[0] === 'chrome-devtools') return undefined;
  if (args.length === 3 && args[0] === 'chrome-devtools' && args[1] === '--lease-wait-ms') {
    const rawWait = args[2];
    if (/^(?:0|[1-9][0-9]*)$/.test(rawWait)) {
      const parsedWait = Number(rawWait);
      if (Number.isSafeInteger(parsedWait) && parsedWait >= 750 && parsedWait <= 300_000) return parsedWait;
    }
  }
  process.stderr.write(usage);
  process.exit(2);
}

const requestedLeaseWaitMs = parseGatewayArguments(process.argv.slice(2));
const cooperativeYieldEnabled = requestedLeaseWaitMs !== undefined;
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

const installRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const statePath = join(installRoot, 'install-state.json');
const recoveryScript = fileURLToPath(new URL('./allow-remote-debugging.ps1', import.meta.url));
const { daemon: daemonPipe, lease: leasePipe } = await prepareEndpoints(installRoot);
const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const gatewayInstanceId = randomUUID();
const defaultLeaseWaitMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS ?? '')
  ? Math.min(750, Number(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS))
  : 750;
const leaseWaitMs = requestedLeaseWaitMs ?? defaultLeaseWaitMs;
const leaseIdleMs = process.env.NODE_ENV === 'test' && /^\d{1,6}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_IDLE_MS)
  : 10 * 60 * 1000;
const shutdownDrainMs = process.env.NODE_ENV === 'test' && /^\d{1,6}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_SHUTDOWN_DRAIN_MS)
  : 130_000;
const leaseYieldQuietGraceMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_GRACE_MS)
  : 250;
const leaseYieldAckMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_ACK_MS)
  : 500;
const leaseYieldCommitMs = process.env.NODE_ENV === 'test' && /^\d{1,5}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_COMMIT_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_COMMIT_MS)
  : 1_500;
const leaseYieldOwnerCloseMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_OWNER_CLOSE_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_OWNER_CLOSE_MS)
  : 500;
const testYieldOwnerCloseDelayMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_OWNER_CLOSE_DELAY_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_YIELD_OWNER_CLOSE_DELAY_MS)
  : 0;
const testBeforeDispatchDelayMs = process.env.NODE_ENV === 'test' && /^\d{1,4}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_BEFORE_DISPATCH_DELAY_MS ?? '')
  ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_BEFORE_DISPATCH_DELAY_MS)
  : 0;

let daemonToken;
let leaseServer;
const leaseSockets = new Set();
let leaseInstanceId;
let leaseAcquiredAt;
let lastLeaseActivityAt;
let lastToolActivityMonotonic;
let leaseIdleTimer;
let yieldPending;
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

class GatewayStoppingError extends Error {
  constructor() {
    super('The gateway is stopping.');
    this.name = 'GatewayStoppingError';
  }
}

function throwIfAcquireStopped(signal) {
  if (shuttingDown) throw new GatewayStoppingError();
  if (signal?.aborted) {
    const cause = signal.reason instanceof Error ? signal.reason : new Error('The lease request was cancelled.');
    cause.name ||= 'AbortError';
    throw cause;
  }
}

function throwIfCommittedTakeoverStopped() {
  if (shuttingDown) throw new GatewayStoppingError();
}

async function acquisitionDelay(milliseconds, signal, committed) {
  if (!committed) return abortableDelay(milliseconds, signal);
  throwIfCommittedTakeoverStopped();
  await delay(milliseconds);
  throwIfCommittedTakeoverStopped();
}

function abortableDelay(milliseconds, signal) {
  throwIfAcquireStopped(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(rejectDelay, signal.reason instanceof Error ? signal.reason : new Error('The lease request was cancelled.'));
    const timer = setTimeout(() => finish(resolveDelay), milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  }).then((value) => {
    throwIfAcquireStopped(signal);
    return value;
  });
}

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
  try { await validatePrivateState(statePath); parsed = JSON.parse(await readFile(statePath, 'utf8')); } catch { throw new Error('The authenticated daemon install state is unavailable.'); }
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
    lease_instance_id: leaseInstanceId,
    acquired_at_utc: new Date(leaseAcquiredAt).toISOString(),
    last_activity_at_utc: new Date(lastLeaseActivityAt).toISOString(),
    in_flight: activeToolCount > 0,
    queue_depth: queuedToolCount,
  };
}

function exactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function yieldReply(request, accepted, reason) {
  return {
    operation: 'yield',
    accepted,
    gateway_instance_id: request.gateway_instance_id,
    lease_instance_id: request.lease_instance_id,
    reason,
  };
}

function clearFailedYield(pending) {
  if (yieldPending !== pending) return;
  clearTimeout(pending.timer);
  clearTimeout(pending.closeTimer);
  clearTimeout(pending.closeFallbackTimer);
  yieldPending = undefined;
  pending.socket.destroy();
  armIdleLeaseRelease();
}

function completeAcknowledgedYield(pending) {
  if (yieldPending !== pending || !pending.acknowledged) return;
  clearTimeout(pending.timer);
  clearTimeout(pending.closeTimer);
  clearTimeout(pending.closeFallbackTimer);
  if (shuttingDown
    || leaseServer !== pending.ownerServer
    || leaseInstanceId !== pending.leaseInstanceId
    || activeToolCount !== 0
    || queuedToolCount !== 0) {
    clearFailedYield(pending);
    return;
  }
  void releaseTaskLease({
    resetState: true,
    expectedServer: pending.ownerServer,
    expectedLeaseInstanceId: pending.leaseInstanceId,
  });
}

function serveLeaseControl(socket, ownerServer) {
  leaseSockets.add(socket);
  socket.once('close', () => leaseSockets.delete(socket));
  socket.setEncoding('utf8');
  socket.setTimeout(leaseYieldAckMs, () => {
    if (yieldPending?.socket === socket) clearFailedYield(yieldPending);
    else socket.destroy();
  });
  let buffer = '';
  let phase = 'request';
  let pending;
  const closeWithReply = (value) => {
    phase = 'done';
    socket.end(`${JSON.stringify(value)}\n`);
  };
  const rejectYield = (request, reason) => closeWithReply(yieldReply(request, false, reason));
  const handleRequest = (request) => {
    if (!exactKeys(request, ['operation', 'token']) && !exactKeys(request, ['gateway_instance_id', 'lease_instance_id', 'operation', 'token'])) {
      socket.destroy();
      return;
    }
    if (!isAuthorizedLeaseStatus(request.token)) {
      socket.destroy();
      return;
    }
    if (leaseServer !== ownerServer || !Number.isFinite(leaseAcquiredAt) || !Number.isFinite(lastLeaseActivityAt) || typeof leaseInstanceId !== 'string') {
      socket.destroy();
      return;
    }
    if (request.operation === 'status' && exactKeys(request, ['operation', 'token'])) {
      closeWithReply(leaseStatusSnapshot());
      return;
    }
    if (request.operation !== 'yield' || !exactKeys(request, ['gateway_instance_id', 'lease_instance_id', 'operation', 'token'])) {
      socket.destroy();
      return;
    }
    if (request.gateway_instance_id !== gatewayInstanceId || request.lease_instance_id !== leaseInstanceId) {
      rejectYield(request, 'stale_lease');
      return;
    }
    if (shuttingDown) {
      rejectYield(request, 'shutting_down');
      return;
    }
    if (yieldPending) {
      rejectYield(request, 'yield_pending');
      return;
    }
    if (activeToolCount !== 0 || queuedToolCount !== 0) {
      rejectYield(request, 'owner_busy');
      return;
    }
    if (!Number.isFinite(lastToolActivityMonotonic) || performance.now() - lastToolActivityMonotonic < leaseYieldQuietGraceMs) {
      rejectYield(request, 'quiet_grace');
      return;
    }

    pending = {
      acknowledged: false,
      leaseInstanceId,
      ownerServer,
      socket,
      closeFallbackTimer: undefined,
      closeTimer: undefined,
      timer: undefined,
    };
    yieldPending = pending;
    clearIdleLeaseTimer();
    phase = 'ack';
    pending.timer = setTimeout(() => clearFailedYield(pending), leaseYieldAckMs);
    socket.write(`${JSON.stringify(yieldReply(request, true, 'accepted'))}\n`);
  };
  const handleAck = (request) => {
    if (!pending || yieldPending !== pending
      || !exactKeys(request, ['gateway_instance_id', 'lease_instance_id', 'operation', 'token'])
      || request.operation !== 'yield_ack'
      || !isAuthorizedLeaseStatus(request.token)
      || request.gateway_instance_id !== gatewayInstanceId
      || request.lease_instance_id !== pending.leaseInstanceId) {
      if (pending) clearFailedYield(pending);
      else socket.destroy();
      return;
    }
    pending.acknowledged = true;
    clearTimeout(pending.timer);
    socket.setTimeout(0);
    phase = 'done';
    pending.closeFallbackTimer = setTimeout(() => {
      if (yieldPending === pending && pending.acknowledged) socket.destroy();
    }, leaseYieldOwnerCloseMs);
    if (testYieldOwnerCloseDelayMs > 0) {
      pending.closeTimer = setTimeout(() => {
        if (yieldPending === pending && pending.acknowledged) socket.end();
      }, testYieldOwnerCloseDelayMs);
    } else {
      socket.end();
    }
  };
  socket.on('data', (chunk) => {
    if (phase === 'done') return;
    buffer += chunk;
    if (buffer.length > 4096) {
      if (pending) clearFailedYield(pending);
      else socket.destroy();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (buffer.trim().length > 0 || line.length === 0) {
      if (pending) clearFailedYield(pending);
      else socket.destroy();
      return;
    }
    let request;
    try { request = JSON.parse(line); } catch {
      if (pending) clearFailedYield(pending);
      else socket.destroy();
      return;
    }
    if (phase === 'request') handleRequest(request);
    else if (phase === 'ack') handleAck(request);
  });
  socket.once('close', () => {
    if (!pending || yieldPending !== pending) return;
    if (pending.acknowledged) completeAcknowledgedYield(pending);
    else clearFailedYield(pending);
  });
  socket.on('error', () => {
    if (pending && yieldPending === pending && !pending.acknowledged) clearFailedYield(pending);
  });
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

function readLeaseOwner(timeout, signal) {
  throwIfAcquireStopped(signal);
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = net.createConnection(leasePipe);
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      callback(value);
    };
    const onAbort = () => finish(rejectStatus, signal.reason instanceof Error ? signal.reason : new Error('The lease request was cancelled.'));
    const timer = setTimeout(() => finish(resolveStatus, { state: 'held_unknown' }), timeout);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(resolveStatus, { state: 'held_unknown' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024) return finish(resolveStatus, { state: 'held_unknown' });
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(resolveStatus, { state: 'held_unknown' }); }
      finish(resolveStatus, isValidHeldLeaseStatus(response) ? { state: 'held', ...response } : { state: 'held_unknown' });
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'status', token: daemonToken })}\n`));
    signal?.addEventListener('abort', onAbort, { once: true });
  }).then((value) => {
    throwIfAcquireStopped(signal);
    return value;
  });
}

function isValidYieldReply(value, owner) {
  return exactKeys(value, ['accepted', 'gateway_instance_id', 'lease_instance_id', 'operation', 'reason'])
    && value.operation === 'yield'
    && typeof value.accepted === 'boolean'
    && value.gateway_instance_id === owner.gateway_instance_id
    && value.lease_instance_id === owner.lease_instance_id
    && typeof value.reason === 'string'
    && value.reason.length > 0;
}

function requestLeaseYield(owner, timeout, signal) {
  throwIfAcquireStopped(signal);
  return new Promise((resolveYield, rejectYield) => {
    const socket = net.createConnection(leasePipe);
    let buffer = '';
    let accepted = false;
    let ackCommitted = false;
    let commitDeadline;
    let commitTimer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      clearTimeout(commitTimer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      callback(value);
    };
    const onAbort = () => finish(rejectYield, signal.reason instanceof Error ? signal.reason : new Error('The lease request was cancelled.'));
    const requestTimer = setTimeout(() => finish(rejectYield, new Error('The authenticated lease yield request timed out.')), timeout);
    const acceptedResult = () => ({ state: 'accepted', ack_committed: true, commit_deadline: commitDeadline });
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({
      operation: 'yield',
      token: daemonToken,
      gateway_instance_id: owner.gateway_instance_id,
      lease_instance_id: owner.lease_instance_id,
    })}\n`));
    socket.on('data', (chunk) => {
      if (accepted) return;
      buffer += chunk;
      if (buffer.length > 4096) return finish(rejectYield, new Error('The lease yield response was too large.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim().length > 0) return finish(rejectYield, new Error('The lease yield response contained extra data.'));
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(rejectYield, new Error('The lease yield response was not valid JSON.')); }
      if (!isValidYieldReply(response, owner)) return finish(rejectYield, new Error('The lease yield response did not match the authenticated owner.'));
      if (!response.accepted) return finish(resolveYield, { state: 'refused', reason: response.reason });
      try { throwIfAcquireStopped(signal); } catch (cause) { return finish(rejectYield, cause); }
      accepted = true;
      try {
        socket.write(`${JSON.stringify({
          operation: 'yield_ack',
          token: daemonToken,
          gateway_instance_id: owner.gateway_instance_id,
          lease_instance_id: owner.lease_instance_id,
        })}\n`);
      } catch (cause) {
        return finish(rejectYield, cause);
      }
      // Once the ACK is queued, the owner can receive it and release. Cancellation
      // can no longer revoke this handoff. Use a separate bounded commit window.
      ackCommitted = true;
      clearTimeout(requestTimer);
      signal?.removeEventListener('abort', onAbort);
      commitDeadline = performance.now() + leaseYieldCommitMs;
      const closeWait = Math.max(1, leaseYieldCommitMs - Math.min(250, Math.floor(leaseYieldCommitMs / 4)));
      commitTimer = setTimeout(() => finish(resolveYield, acceptedResult()), closeWait);
    });
    socket.once('end', () => {
      if (ackCommitted) finish(resolveYield, acceptedResult());
    });
    socket.once('close', () => {
      if (ackCommitted) finish(resolveYield, acceptedResult());
      else if (accepted) finish(rejectYield, new Error('The lease yield connection closed before the ACK was committed.'));
    });
    socket.once('error', (cause) => {
      if (ackCommitted) finish(resolveYield, acceptedResult());
      else finish(rejectYield, cause);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  }).then((value) => {
    if (value?.ack_committed !== true) throwIfAcquireStopped(signal);
    return value;
  });
}

class LeaseBusyError extends Error {
  constructor(lease) {
    super(lease.state === 'held' ? 'The persistent Chrome bridge lease is held by another gateway.' : 'The persistent Chrome bridge lease is held by an unknown or older gateway.');
    this.name = 'LeaseBusyError';
    this.lease = lease;
  }
}

async function closeLeaseCandidate(candidate) {
  await new Promise((resolveClose, rejectClose) => {
    try {
      candidate.close((cause) => {
        if (cause && cause.code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(cause);
        else resolveClose();
      });
    } catch (cause) {
      if (cause?.code === 'ERR_SERVER_NOT_RUNNING') resolveClose();
      else rejectClose(cause);
    }
  });
}

async function acquireTaskLease(signal) {
  throwIfAcquireStopped(signal);
  if (leaseServer) return { acquiredNew: false, leaseInstanceId, ownerServer: leaseServer };
  const requestedDeadline = performance.now() + leaseWaitMs;
  let acquisitionDeadline = requestedDeadline;
  let observedOwner;
  let trustedYieldTransitionUntil = 0;
  let committedYield = false;
  while (performance.now() <= acquisitionDeadline) {
    if (committedYield) throwIfCommittedTakeoverStopped();
    else throwIfAcquireStopped(signal);
    const candidate = net.createServer((socket) => serveLeaseControl(socket, candidate));
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (cause) => { candidate.removeListener('listening', onListening); rejectListen(cause); };
        const onListening = () => { candidate.removeListener('error', onError); resolveListen(); };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(leasePipe);
      });
      if (committedYield) throwIfCommittedTakeoverStopped();
      else throwIfAcquireStopped(signal);
      leaseServer = candidate;
      leaseInstanceId = randomUUID();
      leaseAcquiredAt = Date.now();
      lastLeaseActivityAt = leaseAcquiredAt;
      lastToolActivityMonotonic = performance.now();
      return { acquiredNew: true, committedYield, leaseInstanceId, ownerServer: candidate };
    } catch (cause) {
      await closeLeaseCandidate(candidate);
      if (committedYield) throwIfCommittedTakeoverStopped();
      else throwIfAcquireStopped(signal);
      if (cause.code !== 'EADDRINUSE') throw cause;
      if (committedYield) {
        const committedRemaining = acquisitionDeadline - performance.now();
        if (committedRemaining <= 0) break;
        // Another waiter can bind first after the acknowledged owner releases.
        // Authenticate that successor, then continue within the original wait
        // budget. The old handoff no longer gives us a claim to this lease.
        const successor = await readLeaseOwner(Math.min(100, committedRemaining));
        if (successor.state === 'held'
          && (successor.gateway_instance_id !== observedOwner?.gateway_instance_id
            || successor.lease_instance_id !== observedOwner?.lease_instance_id)) {
          committedYield = false;
          acquisitionDeadline = requestedDeadline;
          trustedYieldTransitionUntil = 0;
          observedOwner = successor;
          throwIfAcquireStopped(signal);
          continue;
        }
        await acquisitionDelay(Math.min(25, committedRemaining), signal, true);
        continue;
      }
      if (performance.now() < trustedYieldTransitionUntil) {
        const transitionRemaining = Math.min(25, trustedYieldTransitionUntil - performance.now(), acquisitionDeadline - performance.now());
        if (transitionRemaining > 0) await abortableDelay(transitionRemaining, signal);
        continue;
      }
      const ownerTimeout = Math.min(100, Math.max(0, acquisitionDeadline - performance.now()));
      if (ownerTimeout > 0) {
        observedOwner = await readLeaseOwner(ownerTimeout, signal);
        if (observedOwner.state !== 'held') throw new LeaseBusyError(observedOwner);
        if (cooperativeYieldEnabled) {
          const yieldTimeout = Math.min(leaseYieldAckMs, Math.max(0, acquisitionDeadline - performance.now()));
          if (yieldTimeout > 0) {
            try {
              const yieldResult = await requestLeaseYield(observedOwner, yieldTimeout, signal);
              if (yieldResult.ack_committed === true) {
                committedYield = true;
                acquisitionDeadline = yieldResult.commit_deadline;
                trustedYieldTransitionUntil = acquisitionDeadline;
              } else if (yieldResult.reason === 'yield_pending') {
                trustedYieldTransitionUntil = performance.now() + leaseYieldAckMs;
              }
            } catch (yieldCause) {
              throwIfAcquireStopped(signal);
              if (performance.now() >= acquisitionDeadline) break;
              if (yieldCause?.code && !['ENOENT', 'ECONNRESET', 'EPIPE'].includes(yieldCause.code)) throw yieldCause;
            }
            if (committedYield) throwIfCommittedTakeoverStopped();
            else throwIfAcquireStopped(signal);
          }
        }
      }
      const remaining = acquisitionDeadline - performance.now();
      if (remaining <= 0) break;
      await acquisitionDelay(Math.min(25, remaining), signal, committedYield);
    }
  }
  if (committedYield) throwIfCommittedTakeoverStopped();
  else throwIfAcquireStopped(signal);
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

async function releaseTaskLease({ resetState = true, expectedServer, expectedLeaseInstanceId } = {}) {
  clearIdleLeaseTimer();
  if (!leaseServer) return;
  if ((expectedServer && leaseServer !== expectedServer) || (expectedLeaseInstanceId && leaseInstanceId !== expectedLeaseInstanceId)) return;
  const server = leaseServer;
  const pending = yieldPending;
  leaseServer = undefined;
  leaseInstanceId = undefined;
  leaseAcquiredAt = undefined;
  lastLeaseActivityAt = undefined;
  lastToolActivityMonotonic = undefined;
  yieldPending = undefined;
  clearTimeout(pending?.timer);
  clearTimeout(pending?.closeTimer);
  clearTimeout(pending?.closeFallbackTimer);
  if (resetState) clearLeaseScopedState();
  for (const socket of leaseSockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function releaseNewAcquisition(acquisition) {
  if (acquisition?.acquiredNew !== true) return;
  await releaseTaskLease({
    resetState: true,
    expectedServer: acquisition.ownerServer,
    expectedLeaseInstanceId: acquisition.leaseInstanceId,
  });
}

async function prepareAcquisitionForDispatch(acquisition, signal) {
  if (testBeforeDispatchDelayMs > 0) await delay(testBeforeDispatchDelayMs);
  try { throwIfAcquireStopped(signal); } catch (cause) {
    await releaseNewAcquisition(acquisition);
    throw cause;
  }
}

function armIdleLeaseRelease() {
  clearIdleLeaseTimer();
  if (!leaseServer || yieldPending || activeToolCount !== 0 || queuedToolCount !== 0 || shuttingDown) return;
  const expectedServer = leaseServer;
  const expectedLeaseInstanceId = leaseInstanceId;
  leaseIdleTimer = setTimeout(() => {
    leaseIdleTimer = undefined;
    if (leaseServer !== expectedServer || leaseInstanceId !== expectedLeaseInstanceId || yieldPending || activeToolCount !== 0 || queuedToolCount !== 0 || shuttingDown) return;
    void releaseTaskLease({ resetState: true, expectedServer, expectedLeaseInstanceId });
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
      owner_lease_instance_id: lease.lease_instance_id,
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

async function invokeChromeTool(name, args, signal) {
  throwIfAcquireStopped(signal);
  const validListPages = name === 'list_pages' && hasNoArguments(args);
  if (name === 'list_pages' && !validListPages) return errorResult('blocked_arguments', 'list_pages accepts an empty argument object only.');
  if (name !== 'list_pages' && !isPlainObject(args)) return errorResult('blocked_arguments', 'Chrome tool arguments must be an object.');
  if (pageState === 'need_list' && name !== 'list_pages') return errorResult('blocked_discovery_required', 'Call list_pages before another Chrome tool in this task.');
  if (pageState === 'need_select' && name !== 'list_pages' && name !== 'select_page') return errorResult('blocked_selection_required', 'Call select_page after list_pages before another Chrome tool in this task.');
  let acquisition;
  try {
    acquisition = await acquireTaskLease(signal);
    await prepareAcquisitionForDispatch(acquisition, signal);
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
  let responsePromise;
  try {
    throwIfAcquireStopped(signal);
    responsePromise = daemonRequest('callTool', payload);
  } catch (cause) {
    await releaseNewAcquisition(acquisition);
    throw cause;
  }
  try {
    response = await responsePromise;
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

async function invokeRecovery(args, signal) {
  if (process.platform !== 'win32') return errorResult('manual_permission_required', 'Approve the Chrome remote-debugging prompt yourself, then start a new gateway session. No browser setting was changed.', { mutated: false });
  throwIfAcquireStopped(signal);
  if (!hasNoArguments(args)) return errorResult('blocked_arguments', 'The recovery action accepts no arguments.', { mutated: false });
  if (!recoveryEligible || recoveryConsumed) return errorResult('blocked_not_eligible', 'Recovery is available one time only after this task’s first dispatched list_pages call fails.', { mutated: false });
  let acquisition;
  try {
    acquisition = await acquireTaskLease(signal);
    await prepareAcquisitionForDispatch(acquisition, signal);
  } catch (cause) {
    if (cause instanceof LeaseBusyError) return leaseBusyResult(cause, 'allow_remote_debugging');
    throw cause;
  }
  let recoveryPromise;
  try {
    throwIfAcquireStopped(signal);
    recoveryPromise = execFileAsync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', recoveryScript], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    recoveryConsumed = true;
    recoveryEligible = false;
  } catch (cause) {
    await releaseNewAcquisition(acquisition);
    throw cause;
  }
  try {
    const { stdout } = await recoveryPromise;
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
  { name: 'chrome-devtools-persistent-gateway', version: '0.1.3' },
  { capabilities: { tools: {} }, instructions: 'One gateway owns the shared Chrome backend while its lease is active. An idle release clears page state. Discover and select a page before other tools.' },
);
const clientTools = [
  ...initialManifest,
  { name: 'allow_remote_debugging', title: 'Inspect and dismiss one verified native Chrome debugging dialog', description: 'Available one time only after this task’s first dispatched list_pages call fails. It invokes no coordinate or general desktop action.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: clientTools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  if (name !== 'allow_remote_debugging' && !expectedTools.has(name)) return errorResult('blocked_unknown_tool', 'The requested tool is not in the pinned gateway allowlist.');
  if (shuttingDown) return errorResult('gateway_shutting_down', 'The gateway parent transport closed. No new tool call was accepted.');
  if (yieldPending) return errorResult('lease_yielding', 'The authenticated idle lease yield is in progress. No tool call was dispatched on the old lease state.', { dispatched: false });
  if (extra.signal.aborted) return errorResult('request_cancelled', 'The MCP client canceled the tool call. No Chrome tool was dispatched by this canceled acquisition.', { dispatched: false });
  clearIdleLeaseTimer();
  queuedToolCount += 1;
  const operation = callQueue.then(async () => {
    queuedToolCount -= 1;
    if (shuttingDown) return errorResult('gateway_shutting_down', 'The gateway parent transport closed. The queued tool was not dispatched.', { dispatched: false });
    if (yieldPending) return errorResult('lease_yielding', 'The authenticated idle lease yield started while this tool was queued. No tool call was dispatched on the old lease state.', { dispatched: false });
    if (extra.signal.aborted) return errorResult('request_cancelled', 'The MCP client canceled the queued tool call. No Chrome tool was dispatched.', { dispatched: false });
    activeToolCount += 1;
    try {
      return await (name === 'allow_remote_debugging' ? invokeRecovery(args, extra.signal) : invokeChromeTool(name, args, extra.signal));
    } catch (cause) {
      if (shuttingDown || cause instanceof GatewayStoppingError) return errorResult('gateway_shutting_down', 'The gateway stopped during lease acquisition. No new Chrome tool was dispatched.', { dispatched: false });
      if (extra.signal.aborted) return errorResult('request_cancelled', 'The MCP client canceled lease acquisition. No Chrome tool was dispatched by this canceled acquisition.', { dispatched: false });
      throw cause;
    } finally {
      activeToolCount -= 1;
      if (leaseServer) {
        lastLeaseActivityAt = Date.now();
        lastToolActivityMonotonic = performance.now();
      }
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

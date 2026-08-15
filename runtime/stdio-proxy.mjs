#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

let daemonToken;
let leaseServer;
let recoveryEligible = false;
let recoveryConsumed = false;
let firstValidListPagesPending = true;
let pageState = 'need_list';
let backendGeneration;
let backendInstanceId;
let callQueue = Promise.resolve();
let shuttingDown = false;

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

async function acquireTaskLease() {
  if (leaseServer) return;
  const testWait = process.env.NODE_ENV === 'test' && /^\d{1,5}$/.test(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS ?? '')
    ? Number(process.env.CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS)
    : 30_000;
  const deadline = Date.now() + testWait;
  while (Date.now() < deadline) {
    try {
      const candidate = net.createServer((socket) => socket.destroy());
      await new Promise((resolveListen, rejectListen) => {
        const onError = (cause) => { candidate.removeListener('listening', onListening); rejectListen(cause); };
        const onListening = () => { candidate.removeListener('error', onError); resolveListen(); };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(leasePipe);
      });
      leaseServer = candidate;
      return;
    } catch (cause) {
      if (cause.code !== 'EADDRINUSE') throw cause;
      await delay(100);
    }
  }
  throw new Error('The persistent Chrome bridge is in use by another Codex task. Finish that task before this task uses Chrome.');
}

async function releaseTaskLease() {
  if (!leaseServer) return;
  const server = leaseServer;
  leaseServer = undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
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
  await acquireTaskLease();
  const validListPages = name === 'list_pages' && hasNoArguments(args);
  if (name === 'list_pages' && !validListPages) return errorResult('blocked_arguments', 'list_pages accepts an empty argument object only.');
  if (name !== 'list_pages' && !isPlainObject(args)) return errorResult('blocked_arguments', 'Chrome tool arguments must be an object.');
  if (pageState === 'need_list' && name !== 'list_pages') return errorResult('blocked_discovery_required', 'Call list_pages before another Chrome tool in this task.');
  if (pageState === 'need_select' && name !== 'list_pages' && name !== 'select_page') return errorResult('blocked_selection_required', 'Call select_page after list_pages before another Chrome tool in this task.');

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
  await acquireTaskLease();
  if (!hasNoArguments(args)) return errorResult('blocked_arguments', 'The recovery action accepts no arguments.', { mutated: false });
  if (!recoveryEligible || recoveryConsumed) return errorResult('blocked_not_eligible', 'Recovery is available one time only after this task’s first dispatched list_pages call fails.', { mutated: false });
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

await readDaemonToken();
const manifestResponse = await daemonRequest('listTools', {}, 20_000);
if (!manifestResponse?.ok) throw new Error(manifestResponse?.detail || 'The reviewed daemon tool manifest is unavailable.');
observeBackend(manifestResponse);
const initialManifest = normalizedManifest(manifestResponse.tools);
const server = new Server(
  { name: 'chrome-devtools-persistent-gateway', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: 'One task owns the shared Chrome backend until this MCP process exits. Discover and select a page before other tools.' },
);
const clientTools = [
  ...initialManifest,
  { name: 'allow_remote_debugging', title: 'Inspect and dismiss one verified native Chrome debugging dialog', description: 'Available one time only after this task’s first dispatched list_pages call fails. It invokes no coordinate or general desktop action.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: clientTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== 'allow_remote_debugging' && !expectedTools.has(name)) return errorResult('blocked_unknown_tool', 'The requested tool is not in the pinned gateway allowlist.');
  const operation = callQueue.then(() => (name === 'allow_remote_debugging' ? invokeRecovery(args) : invokeChromeTool(name, args)));
  callQueue = operation.catch(() => undefined);
  return operation;
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await releaseTaskLease();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
const frontTransport = new StdioServerTransport();
frontTransport.onclose = () => { void shutdown(); };
await server.connect(frontTransport);

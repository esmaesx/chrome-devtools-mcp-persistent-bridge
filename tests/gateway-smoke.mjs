#!/usr/bin/env node

import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
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

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const textOf = (value) => JSON.stringify(value);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(result, status, message) {
  expect(result?.isError === true && textOf(result).includes(status), message);
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
  for (const file of ['daemon.mjs', 'stdio-proxy.mjs', 'allow-remote-debugging.ps1']) {
    await cp(join(repositoryRoot, 'runtime', file), join(root, 'runtime', file));
  }
  await symlink(nodeModules, join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'install-state.json'), JSON.stringify({ install_root: root, daemon_token: 'a'.repeat(64) }), 'utf8');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND: '1',
    CHROME_DEVTOOLS_MCP_TEST_BACKEND: fakeBackend,
    CHROME_DEVTOOLS_MCP_TEST_LEASE_WAIT_MS: '250',
    ...overrides,
  };
  const fixture = { root, env, daemons: [], transports: [] };
  await startDaemon(fixture);
  return fixture;
}

async function connectGateway(fixture, name) {
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(fixture.root, 'runtime', 'stdio-proxy.mjs'), 'chrome-devtools'],
    cwd: fixture.root,
    env: fixture.env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await client.connect(transport);
  } catch (cause) {
    throw new Error(`Gateway connection failed: ${cause.message}\n${stderr}`);
  }
  fixture.transports.push(transport);
  return client;
}

async function closeFixture(fixture) {
  for (const transport of fixture.transports.splice(0)) {
    try { await transport.close(); } catch { }
  }
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

async function normalFlowAndInvalidList() {
  const fixture = await createFixture('normal');
  try {
    const status = await daemonCommand(fixture.root, '--status');
    const statusLines = status.stdout.trim().split(/\r?\n/);
    expect(statusLines.length === 1, 'Status command emitted more than one JSON object.');
    const parsedStatus = JSON.parse(statusLines[0]);
    for (const field of ['pid', 'install_root', 'pipe', 'backend_connected', 'backend_generation']) expect(Object.hasOwn(parsedStatus, field), `Status command is missing ${field}.`);

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
  const fixture = await createFixture('lease');
  try {
    const first = await connectGateway(fixture, 'gateway-lease-first');
    const second = await connectGateway(fixture, 'gateway-lease-second');
    expect(!(await call(first, 'list_pages')).isError, 'First gateway could not acquire the task lease.');
    let secondBlocked = false;
    try {
      await call(second, 'list_pages');
    } catch (cause) {
      secondBlocked = String(cause.message).includes('persistent Chrome bridge is in use');
    }
    expect(secondBlocked, 'Second gateway acquired the task lease.');
  } finally {
    await closeFixture(fixture);
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
  const fixture = await createFixture('recovery-gate', { FAKE_CHROME_FAIL_TOOL: 'list_pages', FAKE_CHROME_FAIL_ONCE_MARKER: marker });
  try {
    const client = await connectGateway(fixture, 'gateway-recovery-gate');
    expectError(await call(client, 'list_pages'), 'backend_call_failed', 'A dispatched list_pages failure was not reported.' );
    const firstRecovery = await call(client, 'allow_remote_debugging');
    expect(firstRecovery?.isError === true && !textOf(firstRecovery).includes('blocked_not_eligible'), 'A dispatched first list_pages failure did not enable one recovery attempt.');
    expectError(await call(client, 'allow_remote_debugging'), 'blocked_not_eligible', 'Recovery was not consumed after one attempt.');
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
    await stopDaemon(fixture);
    const secondStatus = await startDaemon(fixture, firstStatus.daemon_instance_id);
    expect(secondStatus.daemon_instance_id !== firstStatus.daemon_instance_id, 'Daemon restart reused its instance identifier.');
    expectError(await call(client, 'take_snapshot'), 'stale_backend_generation', 'A new daemon accepted old selected-page state.');
    expect(!(await call(client, 'list_pages')).isError, 'Fresh list_pages failed after daemon restart.');
    expect(!(await call(client, 'select_page')).isError, 'Fresh select_page failed after daemon restart.');
    expect(!(await call(client, 'take_snapshot')).isError, 'Old daemon instance state was not cleared before a fresh flow.');
  } finally {
    await closeFixture(fixture);
    await rm(marker, { force: true });
  }
}

await normalFlowAndInvalidList();
await taskLease();
await postDispatchFailureIsNotReplayed();
await dispatchedListFailureEnablesRecoveryOnce();
await exactConnectionErrorEnablesRecoveryButOtherToolErrorsDoNot();
await backendGenerationAndDaemonInstanceReset();
process.stdout.write('Gateway daemon integration tests passed.\n');

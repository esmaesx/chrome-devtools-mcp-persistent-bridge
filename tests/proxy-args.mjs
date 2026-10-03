#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const expectedUsage = 'Usage: stdio-proxy.mjs chrome-devtools [--lease-wait-ms N]; N must be canonical ASCII digits from 750 through 300000.\n';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function runProxy(proxy, cwd, args) {
  const child = spawn(process.execPath, [proxy, ...args], {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [exitCode, signal] = await once(child, 'exit');
  return { exitCode, signal, stdout, stderr };
}

const root = await mkdtemp(join(tmpdir(), 'chrome-bridge-proxy-args-'));
try {
  await mkdir(join(root, 'runtime'), { recursive: true });
  await cp(join(repositoryRoot, 'runtime', 'stdio-proxy.mjs'), join(root, 'runtime', 'stdio-proxy.mjs'));
  await cp(join(repositoryRoot, 'runtime', 'local-endpoints.mjs'), join(root, 'runtime', 'local-endpoints.mjs'));
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const proxy = join(root, 'runtime', 'stdio-proxy.mjs');

  const invalidCases = [
    [],
    ['chrome-devtools', '--lease-wait-ms'],
    ['chrome-devtools', '--lease-wait-ms', '750', '--lease-wait-ms', '750'],
    ['chrome-devtools', 'extra'],
    ['chrome-devtools', '--lease-wait-ms', '750', 'extra'],
    ['chrome-devtools', '--lease-wait-ms', ''],
    ['chrome-devtools', '--lease-wait-ms', '+750'],
    ['chrome-devtools', '--lease-wait-ms', '-750'],
    ['chrome-devtools', '--lease-wait-ms', '750.0'],
    ['chrome-devtools', '--lease-wait-ms', '7.5e2'],
    ['chrome-devtools', '--lease-wait-ms', ' 750'],
    ['chrome-devtools', '--lease-wait-ms', '750 '],
    ['chrome-devtools', '--lease-wait-ms', '７５０'],
    ['chrome-devtools', '--lease-wait-ms', '٠٧٥٠'],
    ['chrome-devtools', '--lease-wait-ms', '0'],
    ['chrome-devtools', '--lease-wait-ms', '749'],
    ['chrome-devtools', '--lease-wait-ms', '300001'],
    ['chrome-devtools', '--lease-wait-ms', '0750'],
    ['chrome-devtools', '--lease-wait-ms', '000750'],
    ['PRIVATE_ARGUMENT_MUST_NOT_BE_ECHOED'],
  ];
  for (const args of invalidCases) {
    const result = await runProxy(proxy, root, args);
    expect(result.exitCode === 2 && result.signal === null, `Invalid arguments did not exit 2: ${JSON.stringify(args)}.`);
    expect(result.stdout === '', `Invalid arguments wrote stdout: ${JSON.stringify(args)}.`);
    expect(result.stderr === expectedUsage, `Invalid arguments did not emit the one fixed usage line: ${JSON.stringify(args)}.`);
    expect(result.stderr.length < 256 && !result.stderr.includes('PRIVATE_ARGUMENT_MUST_NOT_BE_ECHOED'), 'The usage error was not bounded and sanitized.');
  }

  for (const args of [
    ['chrome-devtools'],
    ['chrome-devtools', '--lease-wait-ms', '750'],
    ['chrome-devtools', '--lease-wait-ms', '300000'],
  ]) {
    const result = await runProxy(proxy, root, args);
    expect(result.exitCode === 3 && result.signal === null, `Valid arguments were rejected: ${JSON.stringify(args)}.`);
    expect(result.stdout === '', `Valid startup failure wrote stdout: ${JSON.stringify(args)}.`);
    const lines = result.stderr.trim().split(/\r?\n/);
    expect(lines.length === 1, `Valid startup failure emitted more than one diagnostic: ${JSON.stringify(args)}.`);
    const failure = JSON.parse(lines[0]);
    expect(failure.status === 'startup_failed' && failure.cause === 'install_state_unavailable', `Valid arguments did not reach the expected bounded startup check: ${JSON.stringify(args)}.`);
  }
} finally {
  const tempBase = resolve(tmpdir());
  if (!resolve(root).startsWith(tempBase) || !basename(root).startsWith('chrome-bridge-proxy-args-')) throw new Error('Temporary argument-test cleanup path failed its guard.');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

process.stdout.write('Gateway argument tests passed.\n');

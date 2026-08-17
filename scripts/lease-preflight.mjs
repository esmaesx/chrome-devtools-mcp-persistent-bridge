#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
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

async function readToken(installRoot) {
  try {
    const state = JSON.parse(await readFile(join(installRoot, 'install-state.json'), 'utf8'));
    return isPlainObject(state) && typeof state.daemon_token === 'string' && state.daemon_token.length >= 32
      ? state.daemon_token
      : undefined;
  } catch {
    return undefined;
  }
}

function probeLease(leasePipe, token, timeoutMs = 600) {
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
    const timer = setTimeout(() => finish({ state: 'held_unknown' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', (cause) => finish(cause.code === 'ENOENT' ? { state: 'free' } : { state: 'held_unknown' }));
    socket.once('close', () => finish({ state: 'held_unknown' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024) return finish({ state: 'held_unknown' });
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim().length > 0) return finish({ state: 'held_unknown' });
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish({ state: 'held_unknown' }); }
      finish(isValidHeldLeaseStatus(response) ? { state: 'held', ...response } : { state: 'held_unknown' });
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'status', token: token ?? 'invalid' })}\n`));
  });
}

if (process.argv.length !== 3 || process.argv[2] !== '--from-environment' || typeof process.env.DEV_NEWB_BRIDGE_PREFLIGHT_ROOT !== 'string' || process.env.DEV_NEWB_BRIDGE_PREFLIGHT_ROOT.length === 0) {
  process.stdout.write(`${JSON.stringify({ state: 'held_unknown' })}\n`);
  process.exit(2);
}

const installRoot = resolve(process.env.DEV_NEWB_BRIDGE_PREFLIGHT_ROOT);
const rootHash = createHash('sha256').update(installRoot.toLowerCase()).digest('hex').slice(0, 24);
const leasePipe = `\\\\.\\pipe\\dev-newb-chrome-control-${rootHash}`;
const result = await probeLease(leasePipe, await readToken(installRoot));
process.stdout.write(`${JSON.stringify(result)}\n`);

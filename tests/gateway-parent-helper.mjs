#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(process.argv[2] ?? '');
const mode = process.argv[3] ?? 'idle';
if (!root || !['idle', 'mutation'].includes(mode)) throw new Error('Usage: gateway-parent-helper.mjs <fixture-root> <idle|mutation>');

const client = new Client({ name: `gateway-parent-helper-${mode}`, version: '0.1.3' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'runtime', 'stdio-proxy.mjs'), 'chrome-devtools'],
  cwd: root,
  env: { ...process.env },
  stderr: 'pipe',
});
await client.connect(transport);
const listed = await client.callTool({ name: 'list_pages', arguments: {} });
if (listed?.isError === true) throw new Error('The helper could not acquire the lease.');
if (mode === 'mutation') {
  const selected = await client.callTool({ name: 'select_page', arguments: {} });
  if (selected?.isError === true) throw new Error('The helper could not select a page.');
}
process.stdout.write(`${JSON.stringify({ status: 'ready', proxy_pid: transport.pid })}\n`);
if (mode === 'mutation') {
  const activeMutation = client.callTool({ name: 'click', arguments: {} });
  const queuedMutation = client.callTool({ name: 'click', arguments: {} });
  const [activeResult, queuedResult] = await Promise.all([activeMutation, queuedMutation]);
  process.stdout.write(`${JSON.stringify({ status: 'mutations_returned', active_error: activeResult?.isError === true, queued_error: queuedResult?.isError === true })}\n`);
}
await new Promise(() => {});

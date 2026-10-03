#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'sahar-tacit-setup-check', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../runtime/stdio-proxy.mjs', import.meta.url)), 'chrome-devtools'], stderr: 'pipe' });
const timeout = setTimeout(() => { console.log('ACTION REQUIRED: connection check timed out. Check Chrome and the bridge status.'); void client.close().finally(() => process.exit(3)); }, 20000);
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'list_pages', arguments: {} });
  if (result.isError) { console.log('ACTION REQUIRED: open the intended Chrome session, enable remote debugging, and approve its prompt. Then run check again.'); process.exitCode = 3; }
  else console.log('READY: bridge and Chrome connection are working. Teal extension access still depends on the selected task tab.');
} catch {
  console.log('ACTION REQUIRED: bridge connection unavailable. Run status; finish active agent work if the lease is busy.'); process.exitCode = 3;
} finally { clearTimeout(timeout); await client.close().catch(() => {}); await transport.close().catch(() => {}); }

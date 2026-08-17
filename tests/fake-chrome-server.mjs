#!/usr/bin/env node

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const names = [
  'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form',
  'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
  'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
  'resize_page', 'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot',
  'type_text', 'upload_file', 'wait_for',
];

function record(name, args) {
  if (typeof process.env.FAKE_CHROME_EVENTS_FILE === 'string' && process.env.FAKE_CHROME_EVENTS_FILE.length > 0) {
    appendFileSync(process.env.FAKE_CHROME_EVENTS_FILE, `${JSON.stringify({ name, args })}\n`, 'utf8');
  }
}

function consumeOnce(marker) {
  if (typeof marker !== 'string' || marker.length === 0) return true;
  if (existsSync(marker)) return false;
  writeFileSync(marker, 'used\n', 'utf8');
  return true;
}

let activeCalls = 0;

function recordInterval(phase, name) {
  if (typeof process.env.FAKE_CHROME_INTERVALS_FILE === 'string' && process.env.FAKE_CHROME_INTERVALS_FILE.length > 0) {
    appendFileSync(process.env.FAKE_CHROME_INTERVALS_FILE, `${JSON.stringify({ phase, name, active_calls: activeCalls })}\n`, 'utf8');
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const server = new McpServer({ name: 'fake-chrome-devtools', version: '1.7.0-test' });
for (const name of names) {
  server.registerTool(name, { description: `Test-only ${name}`, inputSchema: {} }, async (args) => {
    activeCalls += 1;
    recordInterval('start', name);
    try {
      record(name, args);
      if (process.env.FAKE_CHROME_DELAY_TOOL === name && /^\d{1,6}$/.test(process.env.FAKE_CHROME_DELAY_MS ?? '')) {
        await delay(Number(process.env.FAKE_CHROME_DELAY_MS));
      }
      if (process.env.FAKE_CHROME_FAIL_TOOL === name && consumeOnce(process.env.FAKE_CHROME_FAIL_ONCE_MARKER)) {
        setTimeout(() => process.exit(23), 5);
        await new Promise(() => {});
      }
      if (name === 'list_pages' && process.env.FAKE_CHROME_CLOSE_AFTER_LIST === '1' && consumeOnce(process.env.FAKE_CHROME_CLOSE_ONCE_MARKER)) {
        setTimeout(() => process.exit(0), 50);
      }
      if (name === 'list_pages' && process.env.FAKE_CHROME_LIST_CONNECTION_ERROR === '1') {
        return {
          content: [{ type: 'text', text: 'Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.\nCause: test-only permission denial' }],
          isError: true,
        };
      }
      if (name === 'list_pages' && process.env.FAKE_CHROME_LIST_TOOL_ERROR === '1') {
        return { content: [{ type: 'text', text: 'Test-only list_pages tool error.' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name, args }) }] };
    } finally {
      activeCalls -= 1;
      recordInterval('end', name);
    }
  });
}
await server.connect(new StdioServerTransport());

const { appendFileSync } = require('node:fs');
const net = require('node:net');

const originalCreateConnection = net.createConnection;
let injected = false;

net.createConnection = function createConnectionWithInjectedStatusFailure(...args) {
  const mode = process.env.CHROME_DEVTOOLS_MCP_TEST_STATUS_FAILURE_MODE;
  const shouldFail = process.argv[2] === '--status' && (mode === 'always' || (mode === 'once' && !injected));
  if (!shouldFail) return originalCreateConnection.apply(this, args);
  injected = true;
  appendFileSync(process.env.CHROME_DEVTOOLS_MCP_TEST_STATUS_FAILURE_MARKER, `${mode}\n`, 'utf8');
  const socket = new net.Socket();
  process.nextTick(() => {
    const cause = new Error('Injected Windows named-pipe connection race.');
    cause.code = mode === 'once' ? 'ENOENT' : 'EBUSY';
    socket.emit('error', cause);
  });
  return socket;
};

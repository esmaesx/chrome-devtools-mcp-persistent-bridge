import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, cp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchPlist } from '../scripts/manage-macos.mjs';
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'sahar-launch-test-')));
const source = fileURLToPath(new URL('../', import.meta.url));
const label = 'com.sahar-tacit.test-' + randomBytes(6).toString('hex');
const plist = join(root, 'test.plist');
const domain = `gui/${process.getuid()}`;
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;');
let loaded = false;
try {
  await mkdir(join(root, 'runtime')); await mkdir(join(root, 'logs'));
  for (const name of ['daemon.mjs','local-endpoints.mjs']) await cp(join(source,'runtime',name),join(root,'runtime',name));
  await symlink(join(source,'node_modules'),join(root,'node_modules'),'dir');
  await writeFile(join(root,'install-state.json'),JSON.stringify({ install_root: root, daemon_token: randomBytes(32).toString('hex') }),{mode:0o600});
  let text = launchPlist(process.execPath,root).replace('com.sahar-tacit.chrome-bridge',label);
  text = text.replace('</dict></plist>', `<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>test</string><key>CHROME_DEVTOOLS_MCP_ALLOW_TEST_BACKEND</key><string>1</string><key>CHROME_DEVTOOLS_MCP_TEST_BACKEND</key><string>${escape(join(source,'tests/fake-chrome-server.mjs'))}</string></dict></dict></plist>`);
  await writeFile(plist,text,{mode:0o600});
  await exec('/usr/bin/plutil',['-lint',plist]);
  await exec('/bin/launchctl',['bootstrap',domain,plist]);loaded=true;
  let status;
  for(let i=0;i<40;i++) {
    try {status=JSON.parse((await exec(process.execPath,[join(root,'runtime/daemon.mjs'),'--status'])).stdout);if(status.ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if (!status?.ok) console.error(await readFile(join(root,'logs/daemon-error.log'),'utf8').catch(()=> 'No daemon log'));
  assert.equal(status?.ok,true,'LaunchAgent failed to start the daemon');
  await exec('/bin/launchctl',['bootout',domain,plist]);loaded=false;
  console.log('PASS: actual macOS LaunchAgent started the authenticated test daemon and stopped cleanly.');
} finally {
  if(loaded)await exec('/bin/launchctl',['bootout',domain,plist]).catch(()=>{});
  await rm(root,{recursive:true,force:true});
}

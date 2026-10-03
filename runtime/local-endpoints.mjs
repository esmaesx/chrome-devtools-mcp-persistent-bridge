import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function localEndpoints(root, platform = process.platform) {
  const identity = platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  if (platform === 'win32') return {
    daemon: `\\\\.\\pipe\\sahar-tacit-chrome-daemon-${hash}`,
    lease: `\\\\.\\pipe\\sahar-tacit-chrome-control-${hash}`,
  };
  if (platform !== 'darwin') throw new Error('This bridge supports Windows and macOS.');
  const directory = `/private/tmp/sahar-tacit-${process.getuid()}`;
  return { directory, daemon: join(directory, `daemon-${hash}.sock`), lease: join(directory, `control-${hash}.sock`) };
}

export async function prepareEndpoints(root) {
  const endpoints = localEndpoints(root);
  if (endpoints.directory) {
    await mkdir(endpoints.directory, { mode: 0o700, recursive: true });
    const info = await lstat(endpoints.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o700 || await realpath(endpoints.directory) !== endpoints.directory) {
      throw new Error('The local socket directory must be a real owner-only directory.');
    }
  }
  return endpoints;
}

export async function validatePrivateState(path) {
  if (process.platform === 'win32') return;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('The install state must be an owner-only regular file.');
  }
}

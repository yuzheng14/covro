// Explicit isolated-daemon fixture: no npm network traffic or user launchd jobs.
import * as childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import process from 'node:process';

const metadata = process.env.COVRO_TEST_RELEASE_METADATA;
if (!metadata) throw new Error('Expected isolated runtime fixture metadata');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  String(url).startsWith('https://registry.npmjs.org/')
    ? Promise.resolve(new globalThis.Response(readFileSync(metadata, 'utf8')))
    : originalFetch(url, options);

if (process.platform === 'darwin') {
  const original = childProcess.execFile;
  const execFile = function (command, args, ...rest) {
    if (command !== '/bin/launchctl') return original(command, args, ...rest);
    const callback = rest.at(-1);
    if (!['print', 'managername'].includes(args[0]))
      throw new Error('Fixture must never mutate launchd');
    globalThis.queueMicrotask(() =>
      callback(
        Object.assign(new Error('No isolated GUI domain'), {
          stderr: 'Could not find domain or service',
        }),
        '',
        'Could not find domain or service',
      ),
    );
    return { kill() {} };
  };
  execFile[promisify.custom] = (command, args, options) =>
    new Promise((resolve, reject) =>
      execFile(command, args, options, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
      ),
    );
  childProcess.default.execFile = execFile;
  syncBuiltinESMExports();
}

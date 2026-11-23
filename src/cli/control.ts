import { join } from 'node:path';
import { readJson } from '../updates/files.js';
import type { RestartRun } from '../shared/service-restart.js';
import { request } from 'node:http';
import type { CovroPaths } from './paths.js';
import lockfile from 'proper-lockfile';
import { setTimeout } from 'node:timers/promises';

/** Local owner control uses a private socket, never the public HTTP authentication boundary. */
export function control<T = unknown>(
  location: CovroPaths,
  action: string,
  input: object = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(input);
    const outgoing = request(
      {
        socketPath: location.socket,
        path: `/${action}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
        },
      },
      (incoming) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 256 * 1024) incoming.destroy(new Error('Control response too large'));
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            const result = JSON.parse(body) as T & { error?: string; code?: string };
            if (incoming.statusCode !== 200)
              reject(
                Object.assign(new Error(result.error ?? 'Control request failed'), {
                  code: result.code,
                }),
              );
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('Covro control timed out')));
    outgoing.on('error', reject);
    outgoing.end(requestBody);
  });
}
export function isNotRunning(error: unknown) {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
}
export const restartFile = (location: CovroPaths) => join(location.state, 'restart.json');

export async function lastServiceRestart(location: CovroPaths) {
  return (await readJson<{ run: RestartRun }>(restartFile(location)))?.run;
}

export async function waitForRestartHandoff(location: CovroPaths) {
  // The old image releases filesystem locks before execve; the durable handoff keeps CLI
  // start/stop from claiming the instance until the new image owns the control socket.
  for (;;) {
    const run = await lastServiceRestart(location);
    if (run?.phase !== 'restarting' || (run.recoveryDeadline ?? 0) <= Date.now()) return;
    await setTimeout(250);
  }
}

export async function stopAndWait(location: CovroPaths) {
  await waitForRestartHandoff(location);
  try {
    await control(location, 'stop');
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (!(await lockfile.check(location.state, { stale: 10_000 }))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await setTimeout(100);
  }
  throw new Error('Covro 尚未完成关闭，请稍后重试');
}

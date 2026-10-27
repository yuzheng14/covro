import { createServer, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// The launchd job receives only this socket path. Credentials stay in memory, never in a plist.
export async function environmentBridge(home: string, runtimePath = process.env.PATH) {
  const path = join(home, `e-${randomBytes(6).toString('hex')}.sock`);
  const clients = new Set<Socket>();
  let accept: (() => void) | undefined;
  const consumed = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const payload = JSON.stringify({
    env: { ...process.env, PATH: runtimePath, COVRO_HOME: home },
    cwd: process.cwd(),
  });
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.end(payload, () => accept?.());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    return {
      path,
      async wait() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            consumed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('launchd 启动环境传递超时，请查看 Covro 日志')),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      async close() {
        for (const socket of clients) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(path, { force: true });
    throw error;
  }
}

// Standalone Node runner also works when the update worker restores a version predating this fix.
// execve preserves launchd's process identity and signal handling without an extra supervisor.
export const launchRunner = `import { connect } from 'node:net';
const [socketPath, entry, config] = process.argv.slice(2);
try {
  const input = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let body = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('launch environment timed out')));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) socket.destroy(new Error('launch environment too large'));
    });
    socket.on('error', reject);
    socket.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid launch environment')); } });
  });
  process.chdir(input.cwd);
  process.execve(process.execPath, [process.execPath, entry, 'run', '--config', config], input.env);
} catch {
  console.error('Covro launch environment unavailable; restart with covro start.');
  process.exitCode = 1;
}
`;

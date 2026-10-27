import { createServer } from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { acquireInstanceLock } from '../server/instance-lock.js';
import { loadConfig } from '../server/config.js';
import { startGateway } from '../server/main.js';
import { packageInfo, paths } from './paths.js';
import { UpdateManager } from '../updates/manager.js';
import { saveJson } from '../updates/files.js';
import { doctor, launchContext } from './doctor.js';
import { runningRuntime } from './runtime.js';

export async function runDaemon(configPath: string) {
  const location = paths(configPath);
  await mkdir(location.state, { recursive: true, mode: 0o700 });
  const release = await acquireInstanceLock(location.state);
  let config: Awaited<ReturnType<typeof loadConfig>>;
  let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
  let updates: UpdateManager | undefined;
  const context = await launchContext();
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST') throw new Error('Expected POST');
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 8192) throw new Error('Control request too large');
      }
      const input: unknown = body ? JSON.parse(body) : {};
      if (request.url === '/status') {
        response.end(
          JSON.stringify({
            version: packageInfo.version,
            pid: process.pid,
            origin: config.publicOrigin[0],
            configPath,
            dataDir: config.dataDir,
            maintenance: runtime?.service.isInMaintenance(),
            codexVersion: runtime?.codex.diagnostics().codexVersion ?? null,
            codexReady: runtime?.codex.ready ?? false,
            launchContext: context,
            runtime: runningRuntime(),
          }),
        );
      } else if (request.url === '/doctor') {
        response.end(JSON.stringify(await doctor()));
      } else if (request.url === '/stop') {
        await stop(() => response.end(JSON.stringify({ stopped: true })));
      } else if (request.url === '/prepare-update') {
        response.end(JSON.stringify(runtime!.service.prepareUpdate()));
      } else if (request.url === '/cancel-update') {
        runtime!.service.setMaintenance(false);
        response.end(JSON.stringify({ cancelled: true }));
      } else if (request.url === '/activate-update') {
        const id = (input as { id?: unknown }).id;
        if (typeof id !== 'string') throw new Error('Invalid upgrade identity');
        await updates!.commitActivation(id);
        runtime!.service.setMaintenance(false);
        response.end(JSON.stringify({ activated: true }));
      } else if (request.url === '/backup-status') {
        response.end(JSON.stringify(await runtime!.backups?.status()));
      } else if (request.url === '/backup-create') {
        if (!runtime!.backups) throw new Error('此实例未配置备份');
        response.end(
          JSON.stringify(await runtime!.backups.start(input as { clientOperationId: string })),
        );
      } else if (request.url === '/update-status') {
        response.end(JSON.stringify(await updates!.status()));
      } else if (request.url === '/update-check') {
        const channel = (input as { channel?: unknown }).channel;
        if (channel !== undefined && !['stable', 'beta', 'dev'].includes(String(channel)))
          throw new Error('Invalid channel');
        response.end(
          JSON.stringify(await updates!.check(channel as 'stable' | 'beta' | 'dev' | undefined)),
        );
      } else if (request.url === '/update') {
        response.end(
          JSON.stringify(await updates!.start(input as Parameters<UpdateManager['start']>[0])),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Unknown control action' }));
      }
    })().catch((error: unknown) => {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Control failed' }),
      );
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = (respond?: () => void) =>
    (stopping ??= (async () => {
      await runtime?.close();
      respond?.();
      await new Promise<void>((done) => server.close(() => done()));
      if (process.platform !== 'win32') await rm(location.socket, { force: true });
      await release();
    })());
  try {
    config = await loadConfig({ configPath, development: false });
    updates = new UpdateManager(
      location,
      config.dataDir,
      () => runtime?.codex.diagnostics().codexVersion ?? null,
    );
    await updates.initialize();
    const maintenance = await updates.activationPending();
    runtime = await startGateway(config, { updates, maintenance });
    if (process.platform !== 'win32') await rm(location.socket, { force: true });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(location.socket, done);
    });
    if (process.platform !== 'win32') await chmod(location.socket, 0o600);
    await saveJson(`${location.state}/instance.json`, {
      root: updates.context?.root,
      config: location.config,
      socket: location.socket,
    });
    console.log(`Covro ${packageInfo.version} listening on ${config.publicOrigin[0]}`);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (error) {
    updates?.close();
    await runtime?.close();
    await release();
    throw error;
  }
}

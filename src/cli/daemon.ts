import { AppError } from '../shared/errors.js';
import { trimBootstrap } from '../logging/bootstrap.js';
import { createLogging } from '../logging/logger.js';
import { loggingOptions } from '../logging/config.js';
import { monitorCrashes } from '../logging/lifecycle.js';
import { errorFields } from '../logging/fields.js';
import { withLogContext } from '../logging/context.js';
import { randomUUID } from 'node:crypto';
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
  const options = loggingOptions(location.logs, packageInfo.version);
  const release = await acquireInstanceLock(location.state);
  await trimBootstrap(location.log).catch(() => {});
  const logging = await createLogging(options);
  const logger = logging.logger.child({ component: 'daemon' });
  const removeMonitor = monitorCrashes(logger, logging.flushSync);
  let config: Awaited<ReturnType<typeof loadConfig>>;
  let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
  let updates: UpdateManager | undefined;
  let context: Awaited<ReturnType<typeof launchContext>>;
  let stage = 'config_read';
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const requestLogger = logger.child({ requestId });
    const started = performance.now();
    response.once('finish', () =>
      requestLogger.debug('control.completed', {
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    void withLogContext({ requestId }, async () => {
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
            codexIdentity: runtime?.codex.launchIdentity?.(),
            launchContext: context,
            runtime: runningRuntime(),
            logging: logging.health(),
          }),
        );
      } else if (request.url === '/doctor') {
        response.end(JSON.stringify({ ...(await doctor()), logging: logging.health() }));
      } else if (request.url === '/stop') {
        await stop(() => response.end(JSON.stringify({ stopped: true })));
      } else if (request.url === '/update-readiness') {
        response.end(JSON.stringify(runtime!.service.prepareUpdate('update', false)));
      } else if (request.url === '/automatic-update-plan') {
        const { id, fresh } = input as { id: string; fresh?: boolean };
        response.end(JSON.stringify(await updates!.automaticPlan(id, fresh)));
      } else if (request.url === '/freeze-automatic-update') {
        const { id, checkedAt } = input as { id: string; checkedAt: number };
        response.end(
          JSON.stringify(
            await updates!.freezeAutomatic(id, checkedAt, () =>
              runtime!.service.prepareUpdate('update', false),
            ),
          ),
        );
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
    }).catch((error: unknown) => {
      requestLogger.warn('control.failed', errorFields(error));
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Control failed',
          code: error instanceof AppError ? error.code : undefined,
        }),
      );
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = (respond?: () => void) =>
    (stopping ??= (async () => {
      let failure: unknown;
      try {
        await runtime?.close();
      } catch (error) {
        failure = error;
        logger.error('daemon.stop_failed', errorFields(error));
      }
      try {
        if (failure) server.closeAllConnections();
        else respond?.();
        await new Promise<void>((done) => server.close(() => done()));
        if (process.platform !== 'win32') await rm(location.socket, { force: true });
      } finally {
        await release();
        logger.info('daemon.stopped', { outcome: failure ? 'failed' : 'succeeded' });
        removeMonitor();
        await logging.close();
      }
      if (failure) throw failure;
    })());
  try {
    context = await launchContext();
    config = await loadConfig({ configPath, development: false });
    stage = 'update_initialize';
    updates = new UpdateManager(
      location,
      config.dataDir,
      () => runtime?.codex.diagnostics().codexVersion ?? null,
      logger.child({ component: 'updates' }),
      () => runtime?.codex.launchIdentity?.(),
    );
    await updates.initialize();
    const maintenance = await updates.activationPending();
    stage = 'gateway_start';
    runtime = await startGateway(config, { updates, maintenance, logger });
    stage = 'control_listener';
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
    logger.info('daemon.ready', { port: config.port });
    process.once(
      'SIGINT',
      () =>
        void stop().catch((error: unknown) => {
          logger.error('daemon.stop_failed', errorFields(error));
          process.exitCode = 1;
        }),
    );
    process.once(
      'SIGTERM',
      () =>
        void stop().catch((error: unknown) => {
          logger.error('daemon.stop_failed', errorFields(error));
          process.exitCode = 1;
        }),
    );
  } catch (error) {
    logger.error('daemon.start_failed', { stage, ...errorFields(error) });
    updates?.close();
    try {
      await runtime?.close();
    } finally {
      await release();
      removeMonitor();
      await logging.close();
    }
    throw new Error(
      'Covro startup failed; inspect covro logs for the failure stage and error code',
      { cause: error },
    );
  }
}

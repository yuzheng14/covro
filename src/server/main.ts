import { createLogging } from '../logging/logger.js';
import { loggingOptions } from '../logging/config.js';
import { monitorCrashes } from '../logging/lifecycle.js';
import { paths, packageInfo } from '../cli/paths.js';
import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { BackupManager } from '../backups/manager.js';
import { createBackupStore } from '../backups/factory.js';
import { assertNoPendingRestore } from '../backups/restore.js';
import type { BackupController } from '../shared/backups.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { CodexAdapter } from '../codex/adapter.js';
import type { CodexClient } from '../codex/types.js';
import { loadConfig, configSource, type AppConfig } from './config.js';
import { acquireInstanceLock } from './instance-lock.js';
import { openDatabase } from './db/index.js';
import { migrateDatabase } from './db/migrate.js';
import { OperationStore } from './db/operations.js';
import { ProjectRegistry } from './projects.js';
import { GatewayService } from './service.js';
import { createApp } from './http.js';
import { startHeartbeat } from './websocket.js';
import { UpdateManager } from '../updates/manager.js';
import type { UpdateController } from '../shared/updates.js';
import { startManagedMcp } from './mcp/server.js';
import { PreviewDiscovery } from './preview/discovery.js';
import { PreviewProxy } from './preview/proxy.js';
import { createAuthenticator } from './auth.js';
import { VitePreviewAdapter } from './preview/vite.js';
import { attachPreviewWebSockets } from './preview/websockets.js';
import type { ProcessInspector } from './preview/processes.js';
export async function startGateway(
  config: AppConfig,
  overrides: {
    logger?: Logger;
    codex?: CodexClient;
    staticDir?: string;
    migrationsDir?: string;
    updates?: UpdateController;
    backups?: BackupController;
    maintenance?: boolean;
    previewInspector?: ProcessInspector;
  } = {},
) {
  const logger = overrides.logger ?? nullLogger;
  const started = performance.now();
  logger.info('gateway.starting');
  const release = await acquireInstanceLock(config.dataDir);
  let closeDatabase: (() => void) | undefined;
  let codex: CodexClient | undefined;
  let mcp: Awaited<ReturnType<typeof startManagedMcp>> | undefined;
  let preview: PreviewProxy | undefined;
  const socketServers: WebSocketServer[] = [];
  let backups: BackupController | undefined = overrides.backups;
  const updates =
    overrides.updates ??
    new UpdateManager(
      undefined,
      undefined,
      () => codex?.diagnostics().codexVersion ?? null,
      logger.child({ component: 'updates' }),
    );
  try {
    const source = configSource(config);
    const backupStore = source
      ? createBackupStore(source.path, config.dataDir, overrides.migrationsDir)
      : undefined;
    if (backupStore) await assertNoPendingRestore(backupStore.options.directory);
    const db = openDatabase(join(config.dataDir, 'app.sqlite'));
    closeDatabase = db.close;
    const packagedMigrations = fileURLToPath(new URL('../drizzle', import.meta.url));
    logger.info('database.migration_started');
    migrateDatabase(
      db.database,
      overrides.migrationsDir ?? (existsSync(packagedMigrations) ? packagedMigrations : undefined),
    );
    logger.info('database.migration_completed');
    let gateway: GatewayService | undefined;
    mcp = await startManagedMcp({
      service: () => gateway,
      publicOrigin: config.publicOrigin[0]!,
      logger: logger.child({ component: 'mcp' }),
    });
    codex =
      overrides.codex ??
      new CodexAdapter({
        ...config.codex,
        logger,
        managedMcp: { name: mcp.name, url: mcp.url },
      });
    const service = new GatewayService({
      logger,
      store: new OperationStore(db.database, logger.child({ component: 'operations' })),
      projects: new ProjectRegistry(config.projects, db.database),
      codex,
      workspacesRoot: join(config.dataDir, 'workspaces'),
      limits: config.limits,
      authMode: config.auth.mode,
      demo: config.demo,
    });
    gateway = service;
    const authenticate = createAuthenticator(config);
    preview = new PreviewProxy(
      new PreviewDiscovery(
        codex,
        (thread, cwd) => service.previewContext(thread, cwd),
        overrides.previewInspector,
        logger.child({ component: 'preview_discovery' }),
      ),
      config,
      authenticate,
      new VitePreviewAdapter(),
      logger.child({ component: 'preview_proxy' }),
    );
    await preview.load();
    service.setMaintenance(overrides.maintenance ?? false);
    backups ??= backupStore
      ? new BackupManager(backupStore, service, { logger: logger.child({ component: 'backups' }) })
      : undefined;
    try {
      await codex.start();
    } catch {
      /* Diagnostics remain available; never substitute a fixture. */
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
    socketServers.push(wss, ...attachPreviewWebSockets(wss, preview));
    const app = createApp({
      config,
      service,
      authenticate,
      preview,
      staticDir: overrides.staticDir ?? fileURLToPath(new URL('../web', import.meta.url)),
      updates,
      backups,
      logger: logger.child({ component: 'http' }),
    });
    const server = serve({
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
      websocket: { server: wss },
    });
    await new Promise<void>((resolveListening, reject) => {
      server.once('listening', resolveListening);
      server.once('error', reject);
    });
    const stopHeartbeats = socketServers.map(startHeartbeat);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        logger.info('gateway.stopping');
        for (const stop of stopHeartbeats) stop();
        preview?.close();
        gateway = undefined;
        updates.close();
        const closed = new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
        for (const ws of socketServers.flatMap((server) => [...server.clients])) {
          ws.close(1001, 'Gateway stopping');
          ws.terminate();
        }
        for (const sockets of socketServers) sockets.close();
        try {
          await mcp?.close();
          await backups?.close();
          await service.shutdown();
        } finally {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await closed;
          try {
            db.close();
          } finally {
            await release();
            logger.info('gateway.stopped');
          }
        }
      })());
    logger.info('gateway.ready', {
      durationMs: Math.round(performance.now() - started),
      port: config.port,
    });
    return { app, server, service, codex, close, updates, backups, mcp, preview };
  } catch (error) {
    preview?.close();
    for (const sockets of socketServers) {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    }
    logger.error('gateway.start_failed', errorFields(error));
    await mcp?.close();
    updates.close();
    await backups?.close();
    try {
      await codex?.stop();
    } finally {
      try {
        closeDatabase?.();
      } finally {
        await release();
      }
    }
    throw error;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let logging: Awaited<ReturnType<typeof createLogging>> | undefined;
  let removeMonitor: (() => void) | undefined;
  try {
    const config = await loadConfig();
    logging = await createLogging(
      loggingOptions(paths(configSource(config)?.path).logs, packageInfo.version),
    );
    removeMonitor = monitorCrashes(logging.logger, logging.flushSync);
    const runtime = await startGateway(config, { logger: logging.logger });
    const stop = () => {
      void runtime
        .close()
        .finally(async () => {
          removeMonitor?.();
          await logging?.close();
        })
        .then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.exitCode = 1;
          },
        );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    logging?.logger.error('process.start_failed', errorFields(error));
    removeMonitor?.();
    await logging?.close();
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 60,
        event: 'process.start_failed',
        ...errorFields(error),
      }),
    );
    process.exitCode = 1;
  }
}

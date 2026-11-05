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
export async function startGateway(
  config: AppConfig,
  overrides: {
    codex?: CodexClient;
    staticDir?: string;
    migrationsDir?: string;
    updates?: UpdateController;
    backups?: BackupController;
    maintenance?: boolean;
  } = {},
) {
  const release = await acquireInstanceLock(config.dataDir);
  let closeDatabase: (() => void) | undefined;
  let codex: CodexClient | undefined;
  let mcp: Awaited<ReturnType<typeof startManagedMcp>> | undefined;
  let backups: BackupController | undefined = overrides.backups;
  const updates =
    overrides.updates ??
    new UpdateManager(undefined, undefined, () => codex?.diagnostics().codexVersion ?? null);
  try {
    const source = configSource(config);
    const backupStore = source
      ? createBackupStore(source.path, config.dataDir, overrides.migrationsDir)
      : undefined;
    if (backupStore) await assertNoPendingRestore(backupStore.options.directory);
    const db = openDatabase(join(config.dataDir, 'app.sqlite'));
    closeDatabase = db.close;
    const packagedMigrations = fileURLToPath(new URL('../drizzle', import.meta.url));
    migrateDatabase(
      db.database,
      overrides.migrationsDir ?? (existsSync(packagedMigrations) ? packagedMigrations : undefined),
    );
    let gateway: GatewayService | undefined;
    mcp = await startManagedMcp({ service: () => gateway, publicOrigin: config.publicOrigin[0]! });
    codex =
      overrides.codex ??
      new CodexAdapter({
        ...config.codex,
        managedMcp: { name: mcp.name, url: mcp.url },
      });
    const service = new GatewayService({
      store: new OperationStore(db.database),
      projects: new ProjectRegistry(config.projects, db.database),
      codex,
      workspacesRoot: join(config.dataDir, 'workspaces'),
      limits: config.limits,
      authMode: config.auth.mode,
      demo: config.demo,
    });
    gateway = service;
    service.setMaintenance(overrides.maintenance ?? false);
    backups ??= backupStore ? new BackupManager(backupStore, service) : undefined;
    try {
      await codex.start();
    } catch {
      /* Diagnostics remain available; never substitute a fixture. */
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
    const app = createApp({
      config,
      service,
      staticDir: overrides.staticDir ?? fileURLToPath(new URL('../web', import.meta.url)),
      updates,
      backups,
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
    const stopHeartbeat = startHeartbeat(wss);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        stopHeartbeat();
        gateway = undefined;
        updates.close();
        const closed = new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
        for (const ws of wss.clients) {
          ws.close(1001, 'Gateway stopping');
          ws.terminate();
        }
        wss.close();
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
          }
        }
      })());
    return { app, server, service, codex, close, updates, backups, mcp };
  } catch (error) {
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
  try {
    const config = await loadConfig();
    const runtime = await startGateway(config);
    console.log(`Codex Web UI listening on ${config.host}:${config.port}`);
    console.log(`Allowed origins: ${config.publicOrigin.join(', ')}`);
    const stop = () => {
      void runtime.close().then(
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
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  }
}

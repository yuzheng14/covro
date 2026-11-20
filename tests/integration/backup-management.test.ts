import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { BackupStore } from '../../src/backups/store.js';
import { BackupManager } from '../../src/backups/manager.js';
import { assertNoPendingRestore, restoreBackup, repairRestore } from '../../src/backups/restore.js';
import { migrateSqlite, readMigrations } from '../../src/server/db/history.js';
import { defaultMigrationsFolder } from '../../src/server/db/migrate.js';
import { verifyDatabaseContract } from '../../scripts/verify-database-contract.js';
import { harness, operationId } from './domain-helpers.js';
import { acquireInstanceLock } from '../../src/server/instance-lock.js';
import { parseConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/http.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function setup(version = 5) {
  const root = await mkdtemp(join(tmpdir(), 'covro-restore-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const config = join(root, 'config.json');
  await writeFile(config, '{"dataDir":"./data","port":8787}');
  const sqlite = new Database(join(dataDir, 'app.sqlite'));
  const migrations = readMigrations(defaultMigrationsFolder);
  migrateSqlite(sqlite, migrations.slice(0, version));
  sqlite.prepare('INSERT INTO preferences VALUES (?, ?)').run('theme', '"dark"');
  sqlite.close();
  const store = new BackupStore({
    directory: join(root, 'backups'),
    dataDir,
    config,
    Sqlite: Database,
    sqliteModulePath: createRequire(import.meta.url).resolve('better-sqlite3'),
    migrations,
    contract: verifyDatabaseContract(),
    appVersion: '0.2.0',
  });
  return { root, dataDir, config, store };
}
it('waits for tasks without interruption, deduplicates submissions, and lets users cancel waiting backups', async () => {
  const { store } = await setup();
  const h = harness();
  cleanup.push(h.close);
  const created = await h.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  await h.service.startTurn(threadId, { clientOperationId: operationId(), text: 'work' });
  const manager = new BackupManager(store, h.service, { pollMs: 5 });
  cleanup.push(() => manager.close());
  const id = randomUUID();
  expect((await manager.start({ clientOperationId: id })).active?.phase).toBe('waiting');
  expect((await manager.start({ clientOperationId: id })).records).toHaveLength(1);
  await expect(manager.start({ clientOperationId: randomUUID() })).rejects.toMatchObject({
    code: 'BACKUP_BUSY',
  });
  const cancelled = await manager.cancel(id);
  expect(cancelled.records[0]?.phase).toBe('cancelled');
  expect(h.service.isInMaintenance()).toBe(false);
  expect(h.codex.starts).toBe(1);
});
it('runs authenticated manual creation/verification routes, rejects traversal and foreign origins, and restores admission', async () => {
  const { store, config } = await setup();
  const h = harness();
  cleanup.push(h.close);
  const manager = new BackupManager(store, h.service, { pollMs: 5 });
  cleanup.push(() => manager.close());
  const app = createApp({
    config: parseConfig({ dataDir: './data' }, config),
    service: h.service,
    staticDir: '/unused',
    backups: manager,
  });
  const id = randomUUID();
  const post = (path: string, value: unknown, origin = 'http://127.0.0.1:8787') =>
    app.request(`http://127.0.0.1:8787${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  expect(
    (await post('/api/backups', { clientOperationId: id }, 'https://foreign.example')).status,
  ).toBe(403);
  expect((await post('/api/backups', { clientOperationId: '../escape' })).status).toBe(400);
  expect((await post('/api/backups', { clientOperationId: id })).status).toBe(202);
  await expect
    .poll(async () => (await manager.status()).records.find((record) => record.id === id)?.phase)
    .toBe('succeeded');
  expect((await post(`/api/backups/${id}/verify`, {})).status).toBe(200);
  expect(h.service.isInMaintenance()).toBe(false);
  await manager.start({ clientOperationId: id });
  expect((await manager.status()).records).toHaveLength(1);
});
it('previews destructive restoration, requires an exact confirmation, refuses a live instance and migrates older backups on a copy', async () => {
  const { store, dataDir, config } = await setup(4);
  await store.create({ id: 'schema-four', trigger: 'manual' });
  const changed = new Database(join(dataDir, 'app.sqlite'));
  changed.prepare('UPDATE preferences SET value=?').run('"light"');
  changed.close();
  await writeFile(config, '{"dataDir":"./data","port":9999}');
  expect(await restoreBackup(store, 'schema-four')).toMatchObject({
    restored: false,
    backupSchema: 4,
    targetSchema: verifyDatabaseContract().schemaVersion,
  });
  await expect(restoreBackup(store, 'schema-four', 'different')).rejects.toMatchObject({
    code: 'RESTORE_CONFIRMATION',
  });
  const release = await acquireInstanceLock(dataDir);
  try {
    await expect(restoreBackup(store, 'schema-four', 'schema-four')).rejects.toMatchObject({
      code: 'INSTANCE_LOCKED',
    });
  } finally {
    await release();
  }
  expect(await restoreBackup(store, 'schema-four', 'schema-four')).toMatchObject({
    restored: true,
  });
  const restored = new Database(join(dataDir, 'app.sqlite'));
  try {
    expect(restored.pragma('user_version', { simple: true })).toBe(
      verifyDatabaseContract().schemaVersion,
    );
    expect(restored.prepare('SELECT value FROM preferences').get()).toEqual({ value: '"dark"' });
  } finally {
    restored.close();
  }
  expect(JSON.parse(await readFile(config, 'utf8')).port).toBe(8787);
  expect((await store.verify('schema-four')).schemaVersion).toBe(4);
});
it('can restore over damaged current data while preserving the damaged originals for inspection', async () => {
  const { store, dataDir, config } = await setup();
  await store.create({ id: 'healthy', trigger: 'manual' });
  await writeFile(join(dataDir, 'app.sqlite'), 'corrupted database');
  await writeFile(config, 'invalid configuration');
  const result = await restoreBackup(store, 'healthy', 'healthy');
  expect(result.restored).toBe(true);
  if (!result.restored) throw new Error('Expected restoration');
  expect(await readFile(join(result.recoveryCopy!, 'original/app.sqlite'), 'utf8')).toBe(
    'corrupted database',
  );
  const restored = new Database(join(dataDir, 'app.sqlite'));
  expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
  restored.close();
});
it('blocks startup after interrupted replacement and repairs the exact original file collection', async () => {
  const { store, dataDir, config } = await setup();
  const id = randomUUID();
  const stage = join(dataDir, `.covro-restore-${id}`, 'original');
  await mkdir(stage, { recursive: true });
  const originals = [];
  for (const name of ['app.sqlite', 'config.json']) {
    const source = name === 'config.json' ? config : join(dataDir, name);
    await copyFile(source, join(stage, name));
    originals.push({
      name,
      sha256: createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    });
  }
  await mkdir(store.options.directory, { recursive: true });
  await writeFile(
    join(store.options.directory, 'restore.json'),
    JSON.stringify({ id, backupId: 'backup', phase: 'replacing', originals }),
  );
  await writeFile(config, '{"dataDir":"./data","port":9999}');
  await assertNoPendingRestore(store.options.directory).then(
    () => {
      throw new Error('must refuse');
    },
    (error) => expect(error.code).toBe('RESTORE_PENDING'),
  );
  expect(await repairRestore(store)).toMatchObject({ repaired: true });
  expect(JSON.parse(await readFile(config, 'utf8')).port).toBe(8787);
  await expect(assertNoPendingRestore(store.options.directory)).resolves.toBeUndefined();
});

it('fails closed when the durable restore journal is malformed', async () => {
  const { store } = await setup();
  await mkdir(store.options.directory, { recursive: true });
  await writeFile(join(store.options.directory, 'restore.json'), 'null');
  await expect(assertNoPendingRestore(store.options.directory)).rejects.toThrow();
});

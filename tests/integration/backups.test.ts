import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { BackupStore } from '../../src/backups/store.js';
import { migrateSqlite, readMigrations } from '../../src/server/db/history.js';
import { defaultMigrationsFolder } from '../../src/server/db/migrate.js';
import { verifyDatabaseContract } from '../../scripts/verify-database-contract.js';
import { acquireMaintenanceLock } from '../../src/backups/lock.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'covro-backup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const config = join(root, 'config.json');
  await writeFile(config, '{"dataDir":"./data","port":8787}');
  const sqlite = new Database(join(dataDir, 'app.sqlite'));
  cleanup.push(() => sqlite.close());
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('wal_autocheckpoint = 0');
  const migrations = readMigrations(defaultMigrationsFolder);
  migrateSqlite(sqlite, migrations);
  sqlite.prepare('INSERT INTO preferences VALUES (?, ?)').run('saved', '"original"');
  sqlite
    .prepare(
      'INSERT INTO project_registrations (id, name, path, canonical_root, removed_at, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('p', 'Original project', root, root, null, 1, 1, 3);
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
  return { root, sqlite, store, config, dataDir };
}
it('backs up uncheckpointed WAL with config, versioned metadata, private permissions and a verified standalone database', async () => {
  const { store, sqlite } = await fixture();
  expect(sqlite.pragma('wal_checkpoint(PASSIVE)')).toBeDefined();
  sqlite.prepare('INSERT INTO preferences VALUES (?, ?)').run('wal-only', '"included"');
  const manifest = await store.create({ id: 'manual', trigger: 'manual' });
  expect(manifest).toMatchObject({
    schemaVersion: verifyDatabaseContract().schemaVersion,
    formatVersion: 1,
    complete: true,
    appVersion: '0.2.0',
    trigger: 'manual',
  });
  expect(manifest.files).toHaveLength(2);
  expect(await store.verify('manual')).toEqual(manifest);
  const copied = new Database(join(store.path('manual'), 'app.sqlite'), { readonly: true });
  try {
    expect(copied.prepare('SELECT value FROM preferences WHERE key=?').get('wal-only')).toEqual({
      value: '"included"',
    });
  } finally {
    copied.close();
  }
  expect((await stat(store.path('manual'))).mode & 0o777).toBe(0o700);
  for (const file of manifest.files)
    expect((await stat(join(store.path('manual'), file.name))).mode & 0o777).toBe(0o600);
  await expect(store.create({ id: 'manual', trigger: 'manual' })).rejects.toThrow();
  expect(await store.verify('manual')).toEqual(manifest);
});
it('reclaims deleted data from the open WAL source and creates a compact, verified backup', async () => {
  const { store, sqlite, dataDir } = await fixture();
  const source = join(dataDir, 'app.sqlite');
  sqlite
    .prepare('INSERT INTO preferences VALUES (?, ?)')
    .run('temporary', JSON.stringify('x'.repeat(2 * 1024 * 1024)));
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const bloatedSize = (await stat(source)).size;
  sqlite.prepare('DELETE FROM preferences WHERE key = ?').run('temporary');
  sqlite.prepare('INSERT INTO preferences VALUES (?, ?)').run('wal-only', '"included"');
  expect(sqlite.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
  expect((await stat(source)).size).toBe(bloatedSize);

  const manifest = await store.create({ id: 'compact', trigger: 'manual' });

  expect((await stat(source)).size).toBeLessThan(bloatedSize / 2);
  expect(sqlite.pragma('freelist_count', { simple: true })).toBe(0);
  expect((await stat(`${source}-wal`)).size).toBe(0);
  expect(await store.verify('compact')).toEqual(manifest);
  const copy = new Database(join(store.path('compact'), 'app.sqlite'), { readonly: true });
  try {
    const preferences = [{ value: '"original"' }, { value: '"included"' }];
    const query = 'SELECT value FROM preferences ORDER BY key';
    expect(sqlite.prepare(query).all()).toEqual(preferences);
    expect(copy.prepare(query).all()).toEqual(preferences);
    expect(copy.pragma('freelist_count', { simple: true })).toBe(0);
    expect(manifest.files.find((file) => file.name === 'app.sqlite')?.size).toBeLessThan(
      bloatedSize / 2,
    );
  } finally {
    copy.close();
  }
});
it('restores configuration, project registrations and preferences after data changes', async () => {
  const { store, sqlite, config } = await fixture();
  await store.create({ id: 'before', trigger: 'preUpgrade', protectedBy: 'upgrade-1' });
  sqlite.prepare('UPDATE preferences SET value=?').run('"changed"');
  sqlite.prepare('UPDATE project_registrations SET name=?, sort_order=?').run('Changed project', 0);
  await writeFile(config, '{"dataDir":"./data","port":9999}');
  // The production caller stops the gateway and closes its handle before replacement.
  sqlite.close();
  cleanup.pop();
  await store.restoreFiles('before');
  const restored = new Database(join(store.options.dataDir, 'app.sqlite'));
  try {
    expect(restored.prepare('SELECT value FROM preferences').get()).toEqual({
      value: '"original"',
    });
    expect(restored.prepare('SELECT name, sort_order FROM project_registrations').get()).toEqual({
      name: 'Original project',
      sort_order: 3,
    });
  } finally {
    restored.close();
  }
  expect(JSON.parse(await readFile(config, 'utf8')).port).toBe(8787);
});
it('detects corrupt files, contradictory manifests and incomplete snapshots before touching live data', async () => {
  const { store, sqlite } = await fixture();
  await store.create({ id: 'broken', trigger: 'manual' });
  await writeFile(join(store.path('broken'), 'config.json'), '{}');
  await expect(store.restoreFiles('broken')).rejects.toThrow('checksum');
  expect(sqlite.prepare('SELECT value FROM preferences').get()).toEqual({ value: '"original"' });
  await rm(join(store.path('broken'), 'snapshot.json'));
  expect((await store.list())[0]?.phase).toBe('corrupt');
  await expect(store.verify('broken')).rejects.toThrow();
});
it('preserves previous backups and reports disk/permission failures without exposing configuration', async () => {
  const { store } = await fixture();
  const good = await store.create({ id: 'good', trigger: 'manual' });
  const failure = vi
    .spyOn(Database.prototype, 'backup')
    .mockRejectedValueOnce(
      Object.assign(new Error('SECRET configuration value'), { code: 'ENOSPC' }),
    );
  await expect(store.create({ id: 'full', trigger: 'preUpgrade' })).rejects.toThrow('空间不足');
  expect(await store.verify('good')).toEqual(good);
  expect((await store.list()).find((record) => record.id === 'full')).toMatchObject({
    phase: 'failed',
    manifest: undefined,
  });
  expect(await readFile(join(store.path('full'), 'record.json'), 'utf8')).not.toContain('SECRET');
  failure.mockRejectedValueOnce(Object.assign(new Error('private/path'), { code: 'EACCES' }));
  await expect(store.create({ id: 'denied', trigger: 'manual' })).rejects.toThrow('权限');
});
it('cancels incomplete snapshots and excludes concurrent backup/update/restore operations', async () => {
  const { store, dataDir } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    store.create({ id: 'cancelled', trigger: 'manual', signal: controller.signal }),
  ).rejects.toThrow('取消');
  expect((await store.list())[0]?.phase).toBe('cancelled');
  const release = await acquireMaintenanceLock(dataDir);
  try {
    await expect(acquireMaintenanceLock(dataDir)).rejects.toMatchObject({
      code: 'MAINTENANCE_BUSY',
    });
  } finally {
    await release();
  }
});

it('isolates malformed catalog metadata without crashing the record list', async () => {
  const { store } = await fixture();
  await store.create({ id: 'metadata', trigger: 'manual' });
  await writeFile(
    join(store.path('metadata'), 'record.json'),
    JSON.stringify({ id: 'metadata', createdAt: 'invalid', phase: 'succeeded' }),
  );
  expect((await store.list())[0]).toMatchObject({ id: 'metadata', phase: 'corrupt', createdAt: 0 });
});

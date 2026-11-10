import { BackupStore } from '../../src/backups/store.js';
import { migrateSqlite, readMigrations } from '../../src/server/db/history.js';
import { defaultMigrationsFolder } from '../../src/server/db/migrate.js';
import { databaseCompatibilitySchema } from '../../src/shared/database.js';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  activateUpdate,
  transactionPaths,
  type UpdateEffects,
} from '../../src/updates/transaction.js';
import {
  compareVersions,
  validVersion,
  inspectPackageDirectory,
  lookupRelease,
} from '../../src/updates/registry.js';
import { harness, operationId } from './domain-helpers.js';
import { paths as cliPaths, packageInfo } from '../../src/cli/paths.js';
import { UpdateManager } from '../../src/updates/manager.js';
import { saveJson } from '../../src/updates/files.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('resolves the scoped dev tag and rejects metadata for another package', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  cleanups.push(() => fetch.mockRestore());
  fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ name: '@covro/covro', version: '0.1.0-dev.1' })),
  );
  expect(await lookupRelease('dev')).toMatchObject({
    name: '@covro/covro',
    version: '0.1.0-dev.1',
  });
  expect(fetch).toHaveBeenCalledWith(
    'https://registry.npmjs.org/%40covro%2Fcovro/dev',
    expect.objectContaining({ headers: { accept: 'application/json' } }),
  );
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ name: 'covro', version: '0.1.0' })));
  await expect(lookupRelease('stable')).rejects.toThrow();
});

it('orders immutable release versions and prereleases without treating dev as stable', () => {
  expect(compareVersions('0.3.0-dev.10', '0.3.0-dev.9')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
  expect(compareVersions('0.3.0', '0.2.99')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0+abc', '0.3.0+def')).toBe(0);
  for (const version of [
    'latest',
    '../bad',
    '1.2.3;sh',
    '1.2.3-dev.01',
    '01.2.3',
    '1.2.3+..',
    '1.2.3+build.',
  ])
    expect(validVersion(version)).toBe(false);
});

it('blocks activation for in-flight and unknown executions, then atomically rejects new work after idle admission', async () => {
  const h = harness();
  cleanups.push(h.close);
  const created = await h.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const turn = await h.service.startTurn(id, { clientOperationId: operationId(), text: 'task' });
  expect(h.service.prepareUpdate().ready).toBe(false);
  h.codex.complete(id, turn.execution!.turnId!);
  expect(h.service.prepareUpdate()).toEqual({ ready: true });
  await expect(
    h.service.startTurn(id, { clientOperationId: operationId(), text: 'must not dispatch' }),
  ).rejects.toMatchObject({ code: 'UPDATE_MAINTENANCE' });
  expect(h.codex.starts).toBe(1);
  h.service.setMaintenance(false);
  await h.service.startTurn(id, { clientOperationId: operationId(), text: 'next' });
  h.codex.reset();
  expect(h.service.prepareUpdate().ready).toBe(false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'covro-upgrade-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = transactionPaths(
    join(root, 'npm/@covro/covro'),
    'test-update',
    join(root, 'data'),
    join(root, 'config.json'),
    join(root, 'backup'),
  );
  expect(paths.candidate).toBe(
    join(
      paths.prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      '@covro/covro',
    ),
  );
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.candidate, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(join(paths.root, 'version'), 'old');
  await writeFile(join(paths.candidate, 'version'), 'new');
  await writeFile(paths.config, '{"dataDir":"./data"}');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  const migrations = readMigrations(defaultMigrationsFolder);
  migrateSqlite(db, migrations);
  db.exec("INSERT INTO preferences VALUES ('original', '\"kept\"')");
  db.close();
  const backups = new BackupStore({
    directory: dirname(paths.backup),
    config: paths.config,
    dataDir: paths.dataDir,
    appVersion: packageInfo.version,
    contract: databaseCompatibilitySchema.parse(packageInfo.covroDatabase),
    migrations,
    Sqlite: Database,
  });
  const phases: string[] = [];
  const effects: UpdateEffects = {
    waitForIdle: vi.fn(async () => {}),
    backup: async () => {
      await backups.create({ id: 'backup', trigger: 'preUpgrade' });
    },
    restore: async () => {
      await backups.restoreFiles('backup');
    },
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    phase: async (phase) => {
      phases.push(phase);
    },
  };
  return { paths, effects, phases };
}

it('restores the complete package and original SQLite records after a candidate migration fails', async () => {
  const { paths, effects, phases } = await fixture();
  effects.verify = async () => {
    const db = new Database(join(paths.dataDir, 'app.sqlite'));
    db.exec('ALTER TABLE preferences ADD COLUMN changed TEXT; DELETE FROM preferences');
    db.close();
    throw new Error('candidate failed readiness');
  };
  await expect(activateUpdate(paths, effects)).rejects.toThrow('candidate failed readiness');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  try {
    expect(db.prepare('SELECT * FROM preferences').all()).toEqual([
      { key: 'original', value: '"kept"' },
    ]);
  } finally {
    db.close();
  }
  expect(phases.at(-1)).toBe('rolledBack');
  expect(effects.start).toHaveBeenLastCalledWith(false);
});

it('reopens admission without stopping or backing up when the final restart-source probe fails', async () => {
  const { paths, effects, phases } = await fixture();
  effects.beforeStop = async () => {
    throw new Error('restart source changed');
  };
  effects.resume = vi.fn(async () => {});
  const backup = vi.spyOn(effects, 'backup');
  await expect(activateUpdate(paths, effects)).rejects.toThrow('restart source changed');
  expect(effects.stop).not.toHaveBeenCalled();
  expect(backup).not.toHaveBeenCalled();
  expect(effects.resume).toHaveBeenCalledOnce();
  expect(phases).toEqual(['waiting', 'failed']);
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
});

it('keeps the candidate and new data after a committed activation response is lost', async () => {
  const { paths, effects } = await fixture();
  effects.commit = async () => {
    const db = new Database(join(paths.dataDir, 'app.sqlite'));
    db.exec("INSERT INTO preferences VALUES ('new-write', '\"acknowledged\"')");
    db.close();
    throw new Error('response lost');
  };
  effects.hasCommitted = async () => true;
  await activateUpdate(paths, effects);
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('new');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM preferences').get()).toEqual({ count: 2 });
  } finally {
    db.close();
  }
  expect(effects.start).not.toHaveBeenCalledWith(false);
});

it('restarts the original service when stopping fails after the process has exited', async () => {
  const { paths, effects, phases } = await fixture();
  effects.stop = vi
    .fn()
    .mockRejectedValueOnce(new Error('service manager stop failed'))
    .mockResolvedValue(undefined);
  await expect(activateUpdate(paths, effects)).rejects.toThrow('service manager stop failed');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
  expect(effects.start).toHaveBeenCalledWith(false);
  expect(phases.at(-1)).toBe('rolledBack');
});

it('refuses to start an uncommitted candidate after interrupted rollback', async () => {
  const { paths } = await fixture();
  const manager = new UpdateManager(
    { ...cliPaths(paths.config), home: paths.backup },
    paths.dataDir,
  );
  const run = {
    id: operationId(),
    from: '0.0.0',
    target: packageInfo.version,
    channel: 'stable',
    phase: 'failed',
    message: 'recovery interrupted',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveJson(join(manager.context!.directory, 'run.json'), run);
  await expect(manager.activationPending()).rejects.toThrow('covro update repair');
  await saveJson(join(manager.context!.directory, 'run.json'), {
    ...run,
    from: packageInfo.version,
  });
  expect(await manager.activationPending()).toBe(false);
});

it('rejects npm-linked source checkouts and Git workspaces before replacing an installation', async () => {
  const { paths } = await fixture();
  const globalRoot = join(paths.backup, 'node_modules');
  const installation = join(globalRoot, '@covro/covro');
  await mkdir(dirname(installation), { recursive: true });
  await symlink(paths.root, installation, 'dir');
  expect(await inspectPackageDirectory(paths.root, globalRoot)).toContain('链接');
  await rm(installation);
  await mkdir(installation);
  expect(await inspectPackageDirectory(installation, globalRoot)).toBeUndefined();
  await writeFile(join(installation, '.git'), 'gitdir: /source/worktree');
  expect(await inspectPackageDirectory(installation, globalRoot)).toContain('Git 工作区');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
});

it('does not replace the package or migrate when the required backup fails', async () => {
  const { paths, effects } = await fixture();
  effects.backup = async () => {
    throw new Error('Backup disk full');
  };
  await expect(activateUpdate(paths, effects)).rejects.toThrow('Backup disk full');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
  expect(effects.start).toHaveBeenCalledWith(false);
  expect(effects.verify).not.toHaveBeenCalled();
  expect(effects.commit).not.toHaveBeenCalled();
});

it('checks idle readiness without closing task admission and still blocks unknown operations', async () => {
  const h = harness();
  cleanups.push(h.close);
  expect(h.service.prepareUpdate('update', false)).toEqual({ ready: true });
  expect(h.service.isInMaintenance()).toBe(false);
  const created = await h.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await h.service.startTurn(id, { clientOperationId: operationId(), text: 'still admitted' });
  expect(h.service.prepareUpdate('update', false).ready).toBe(false);
  h.codex.reset();
  expect(h.service.prepareUpdate('update', false).ready).toBe(false);
  expect(h.service.isInMaintenance()).toBe(false);
});

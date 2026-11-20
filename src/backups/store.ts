import { z, ZodError } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import {
  backupIdSchema,
  backupManifestSchema,
  backupRecordSchema,
  type BackupManifest,
  type BackupRecord,
} from '../shared/backups.js';
import { AppError } from '../shared/errors.js';
import type { DatabaseCompatibility } from '../shared/database.js';
import {
  inspectDatabase,
  readMigrations,
  requireRestorable,
  type Migration,
} from '../server/db/history.js';
import { MAX_CONFIG_BYTES } from '../server/config-store.js';
import { parseConfig, parseFileConfig } from '../server/config.js';
import { copyDurable, readJson, saveJson } from '../updates/files.js';
import { compactDatabase } from './compact.js';

export interface BackupOptions {
  directory: string;
  config: string;
  dataDir: string;
  appVersion: string;
  commit?: string;
  contract: DatabaseCompatibility;
  migrations: Migration[];
  Sqlite: typeof Database;
  sqliteModulePath: string;
}
export const backupDirectory = (home: string, dataDir: string) =>
  join(home, 'backups', createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16));

async function fingerprint(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Backup contains a non-regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}
export function backupFailure(error: unknown) {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return '服务配置无效，备份未完成；请检查配置后重试。';
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'SQLITE_FULL') return '磁盘空间不足，备份未完成。';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return '无法写入备份目录，请检查文件权限。';
  if (code === 'ELOCKED') return '配置或备份目录正在被其他操作使用，请稍后重试。';
  return '备份验证或文件操作失败，请检查磁盘、权限及文件完整性后重试。';
}

export class BackupStore {
  constructor(readonly options: BackupOptions) {}
  path(id: string) {
    return join(this.options.directory, backupIdSchema.parse(id));
  }
  async record(record: BackupRecord) {
    await saveJson(join(this.path(record.id), 'record.json'), record);
  }
  async list(): Promise<BackupRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: BackupRecord[] = [];
    for (const id of names.filter((name) => backupIdSchema.safeParse(name).success)) {
      try {
        const value = await readJson(join(this.path(id), 'record.json'));
        if (value === undefined) continue;
        const record = backupRecordSchema.parse(value);
        if (record.id !== id) throw new Error('Backup record identity mismatch');
        const parsed = backupManifestSchema.safeParse(
          await readJson(join(this.path(id), 'snapshot.json')),
        );
        if (parsed.success && parsed.data.id === id)
          records.push({
            ...record,
            path: this.path(id),
            phase: ['waiting', 'copying', 'verifying'].includes(record.phase)
              ? 'succeeded'
              : record.phase,
            manifest: parsed.data,
          });
        else
          records.push({
            ...record,
            path: this.path(id),
            phase: record.phase === 'succeeded' ? 'corrupt' : record.phase,
            manifest: undefined,
          });
      } catch {
        records.push({
          id,
          path: this.path(id),
          phase: 'corrupt',
          trigger: 'manual',
          createdAt: 0,
          updatedAt: 0,
          message: '备份记录损坏，不能恢复。',
        });
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Caller must hold the maintenance lock and pause application writes. */
  async create(input: {
    id?: string;
    trigger: BackupManifest['trigger'];
    protectedBy?: string;
    signal?: AbortSignal;
    reserved?: boolean;
    progress?: (record: BackupRecord) => void;
  }): Promise<BackupManifest> {
    const { Sqlite, migrations, config, dataDir, appVersion, commit } = this.options;
    const id = backupIdSchema.parse(input.id ?? randomUUID());
    const directory = this.path(id);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.options.directory)).isDirectory() ||
      (await lstat(this.options.directory)).isSymbolicLink()
    )
      throw new Error('Invalid backup directory');
    await chmod(this.options.directory, 0o700);
    // Exclusive creation prevents overwriting a usable backup or replaying the same operation.
    if (input.reserved) {
      const reserved = await readJson<BackupRecord>(join(directory, 'record.json'));
      if (
        reserved?.id !== id ||
        reserved.phase !== 'waiting' ||
        (await readJson(join(directory, 'snapshot.json')))
      )
        throw new Error('Invalid backup reservation');
    } else await mkdir(directory, { mode: 0o700 });
    const record: BackupRecord = {
      id,
      phase: 'copying',
      trigger: input.trigger,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path: directory,
      message: '正在生成数据库与配置快照',
    };
    let release: (() => Promise<void>) | undefined;
    let sqlite: Database.Database | undefined;
    try {
      await this.record(record);
      input.progress?.({ ...record });
      input.signal?.throwIfAborted();
      release = await lockfile.lock(config, { realpath: false, retries: 0 });
      const configStat = await lstat(config);
      if (!configStat.isFile() || configStat.size > MAX_CONFIG_BYTES)
        throw new Error('Invalid config file');
      const contents = await readFile(config, 'utf8');
      if (parseConfig(JSON.parse(contents), config).dataDir !== resolve(dataDir))
        throw new Error('Saved configuration no longer identifies the running data directory');
      const configFile = await open(join(directory, 'config.json'), 'wx', 0o600);
      try {
        await configFile.writeFile(contents);
        await configFile.sync();
      } finally {
        await configFile.close();
      }
      const source = join(dataDir, 'app.sqlite');
      sqlite = new Sqlite(source, { readonly: true, fileMustExist: true });
      const history = inspectDatabase(sqlite, migrations);
      requireRestorable(history.schemaVersion, this.options.contract);
      input.signal?.throwIfAborted();
      await compactDatabase(source, this.options.sqliteModulePath);
      input.signal?.throwIfAborted();
      await sqlite.backup(join(directory, 'app.sqlite'), {
        progress: ({ totalPages, remainingPages }) => {
          input.signal?.throwIfAborted();
          input.progress?.({
            ...record,
            progress: Math.round(((totalPages - remainingPages) / totalPages) * 100),
          });
          return 100;
        },
      });
      sqlite.close();
      sqlite = undefined;
      await chmod(join(directory, 'app.sqlite'), 0o600);
      if ((await readFile(config, 'utf8')) !== contents)
        throw new Error('Configuration changed externally during backup');
      input.signal?.throwIfAborted();
      record.phase = 'verifying';
      record.message = '正在验证备份完整性';
      record.updatedAt = Date.now();
      await this.record(record);
      input.progress?.({ ...record });
      const files = await Promise.all(
        (['app.sqlite', 'config.json'] as const).map(async (name) => ({
          name,
          ...(await fingerprint(join(directory, name))),
        })),
      );
      const manifest = backupManifestSchema.parse({
        formatVersion: 1,
        complete: true,
        id,
        createdAt: record.createdAt,
        appVersion,
        commit,
        trigger: input.trigger,
        configPath: config,
        dataDir,
        schemaVersion: history.schemaVersion,
        migrationHashes: history.migrationHashes,
        files,
        protectedBy: input.protectedBy,
      });
      this.checkDatabase(directory, manifest);
      // Make the copied SQLite durable before publishing the completion manifest.
      const file = await open(join(directory, 'app.sqlite'), 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      input.signal?.throwIfAborted();
      await saveJson(join(directory, 'snapshot.json'), manifest);
      record.phase = 'succeeded';
      record.message = '备份成功，完整性验证通过';
      record.updatedAt = Date.now();
      record.manifest = manifest;
      await this.record(record).catch(() => {});
      input.progress?.({ ...record });
      return manifest;
    } catch (error) {
      record.phase = input.signal?.aborted ? 'cancelled' : 'failed';
      record.message = input.signal?.aborted
        ? '备份已取消，未生成可恢复快照。'
        : backupFailure(error);
      record.updatedAt = Date.now();
      await this.record(record).catch(() => {});
      input.progress?.({ ...record });
      throw new AppError('BACKUP_FAILED', record.message, 500);
    } finally {
      sqlite?.close();
      await release?.();
    }
  }
  private checkDatabase(directory: string, manifest: BackupManifest) {
    const sqlite = new this.options.Sqlite(join(directory, 'app.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (
        sqlite.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (sqlite.pragma('foreign_key_check') as unknown[]).length
      )
        throw new Error('Invalid backup database');
      const history = inspectDatabase(sqlite, this.options.migrations);
      requireRestorable(history.schemaVersion, this.options.contract);
      if (
        history.schemaVersion !== manifest.schemaVersion ||
        JSON.stringify(history.migrationHashes) !== JSON.stringify(manifest.migrationHashes)
      )
        throw new Error('Backup database differs from manifest');
    } finally {
      sqlite.close();
    }
  }
  async verify(id: string): Promise<BackupManifest> {
    const directory = this.path(id);
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
      throw new Error('Invalid backup directory');
    const manifest = backupManifestSchema.parse(await readJson(join(directory, 'snapshot.json')));
    if (manifest.id !== id) throw new Error('Backup identity mismatch');
    for (const file of manifest.files) {
      const actual = await fingerprint(join(directory, file.name));
      if (actual.size !== file.size || actual.sha256 !== file.sha256)
        throw new Error('Backup checksum mismatch');
    }
    parseFileConfig(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')));
    this.checkDatabase(directory, manifest);
    return manifest;
  }
  /** Caller must own the instance lock, and must not have resumed business writes. */
  async restoreFiles(id: string) {
    await this.verify(id);
    for (const name of ['app.sqlite-wal', 'app.sqlite-shm'])
      await rm(join(this.options.dataDir, name), { force: true });
    await copyDurable(join(this.path(id), 'app.sqlite'), join(this.options.dataDir, 'app.sqlite'));
    await chmod(join(this.options.dataDir, 'app.sqlite'), 0o600);
    await copyDurable(join(this.path(id), 'config.json'), this.options.config);
    await chmod(this.options.config, 0o600);
  }
}

/** Read-only verification for snapshots created before versioned manifests existed. */
export async function verifyLegacySnapshot(
  directory: string,
  Sqlite: typeof Database,
  migrationsFolder: string,
) {
  z.object({ complete: z.literal(true) })
    .strict()
    .parse(await readJson(join(directory, 'snapshot.json')));
  parseFileConfig(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')));
  const db = new Sqlite(join(directory, 'app.sqlite'), { readonly: true, fileMustExist: true });
  try {
    if (
      db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length
    )
      throw new Error('旧备份数据库损坏');
    inspectDatabase(db, readMigrations(migrationsFolder));
  } finally {
    db.close();
  }
}

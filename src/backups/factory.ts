import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { packageInfo, paths } from '../cli/paths.js';
import { databaseCompatibilitySchema } from '../shared/database.js';
import { readMigrations } from '../server/db/history.js';
import { runtimeMigrationsFolder } from '../server/db/migrate.js';
import { BackupStore, backupDirectory } from './store.js';

export function createBackupStore(
  config: string,
  dataDir: string,
  migrationsFolder = runtimeMigrationsFolder,
) {
  return new BackupStore({
    directory: backupDirectory(paths(config).home, dataDir),
    config,
    dataDir,
    appVersion: packageInfo.version,
    commit: packageInfo.covroCommit,
    contract: databaseCompatibilitySchema.parse(packageInfo.covroDatabase),
    migrations: readMigrations(migrationsFolder),
    Sqlite: Database,
    sqliteModulePath: createRequire(import.meta.url).resolve('better-sqlite3'),
  });
}

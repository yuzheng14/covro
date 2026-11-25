import { inspectDatabase, readMigrations } from './history.js';
import { runtimeMigrationsFolder } from './migrate.js';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** The caller must hold the data directory instance lock before opening/migrating. */
export function openDatabase(filename: string): { database: AppDatabase; close: () => void } {
  if (filename !== ':memory:' && existsSync(filename)) {
    const preflight = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      inspectDatabase(preflight, readMigrations(runtimeMigrationsFolder));
    } finally {
      preflight.close();
    }
  }
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    chmodSync(dirname(filename), 0o700);
  }
  const sqlite = new Database(filename);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  return { database: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

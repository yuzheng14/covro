import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/server/db/index.js';
import { migrateDatabase } from '../../src/server/db/migrate.js';
import { OperationStore } from '../../src/server/db/operations.js';
import type { Logger } from '../../src/logging/logger.js';

/** Real on-disk SQLite, using exactly the committed production migrations. */
export function databaseHarness(logger?: Logger) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-database-'));
  const filename = join(directory, 'data', 'app.sqlite');
  const db = openDatabase(filename);
  migrateDatabase(db.database);
  const store = new OperationStore(db.database, logger);
  return {
    directory,
    filename,
    db,
    store,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

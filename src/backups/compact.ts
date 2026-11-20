import { Worker } from 'node:worker_threads';

// The gateway and the bundled upgrade worker share this script and pass the SQLite
// module from the installation that owns the source database.
const script = `
  const { parentPort, workerData } = require('node:worker_threads');
  try {
    const Sqlite = require(workerData.sqliteModulePath);
    const db = new Sqlite(workerData.filename, { fileMustExist: true });
    try {
      db.exec('VACUUM');
      // In WAL mode the main file only shrinks once the new pages are checkpointed.
      const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)');
      if (checkpoint.busy) {
        throw Object.assign(new Error('WAL checkpoint was blocked'), { code: 'SQLITE_BUSY' });
      }
    } finally {
      db.close();
    }
  } catch (error) {
    parentPort.postMessage(error.code || 'SQLITE_COMPACTION_FAILED');
  }
`;

export function compactDatabase(filename: string, sqliteModulePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Keep the gateway responsive and let the maintenance and configuration locks renew.
    const worker = new Worker(script, {
      eval: true,
      execArgv: [],
      workerData: { filename, sqliteModulePath },
    });
    let error: Error | undefined;
    worker.once('message', (code: string) => {
      error = Object.assign(new Error('Source database compaction failed'), { code });
    });
    worker.once('error', (failure) => {
      error = failure;
    });
    worker.once('exit', (code) => {
      if (error) reject(error);
      else if (code !== 0) reject(new Error('Database compaction worker exited early'));
      else resolve();
    });
  });
}

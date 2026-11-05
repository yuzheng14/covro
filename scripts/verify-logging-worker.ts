import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The update worker is copied out of the npm installation before the upgrade. */
export async function verifyLoggingWorker() {
  const root = await mkdtemp(join(tmpdir(), 'covro-worker-log-'));
  try {
    const directory = join(root, 'update');
    const state = join(root, 'state');
    await mkdir(directory);
    await mkdir(state);
    const entry = join(root, 'worker.cjs');
    await cp('dist/update-worker.cjs', entry);
    await writeFile(
      join(directory, 'context.json'),
      JSON.stringify({ location: { state }, root: resolve('.'), dataDir: join(root, 'data') }),
    );
    let exitCode: string | number | undefined;
    try {
      await promisify(execFile)(process.execPath, [entry, directory], {
        cwd: root,
        timeout: 10000,
      });
    } catch (error) {
      const failed = error as { code?: string | number; stderr?: string };
      exitCode = failed.code;
      assert.match(failed.stderr ?? '', /update.bootstrap_failed/);
    }
    assert.equal(exitCode, 1);
    const logs = join(state, 'logs');
    const files = (await readdir(logs)).filter((name) => name.endsWith('.jsonl'));
    const records = (
      await Promise.all(files.map((name) => readFile(join(logs, name), 'utf8')))
    ).join('');
    assert.match(records, /update.worker_failed/);
    assert.match(records, /update.worker_finished/);
    console.log('PASS: standalone update worker persists structured logs without node_modules');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

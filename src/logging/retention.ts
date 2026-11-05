import { readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Per-process names prevent competing rotation writers; cleanup spans previous runs.
export const logFilename = /^covro\.[a-z0-9-]+(?:\.[0-9-]+)*\.\d+\.jsonl$/;
export async function logFiles(directory: string) {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = await Promise.all(
    entries
      .filter((name) => logFilename.test(name))
      .map(async (name) => {
        const path = join(directory, name);
        try {
          const stat = await lstat(path);
          return stat.isFile() && !stat.isSymbolicLink()
            ? { name, path, size: stat.size, mtimeMs: stat.mtimeMs }
            : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
      }),
  );
  return files
    .filter((file) => file !== undefined)
    .sort(
      (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
}
export async function cleanLogs(
  directory: string,
  options: {
    maxAgeDays: number;
    maxTotalBytes: number;
    activeRunIds?: string[];
    now?: number;
  },
) {
  const files = await logFiles(directory);
  let total = files.reduce((size, file) => size + file.size, 0);
  const cutoff = (options.now ?? Date.now()) - options.maxAgeDays * 86400_000;
  const activeRuns = new Set(options.activeRunIds);
  for (const name of await readdir(directory)) {
    const match = /^\.active\.(\d+)\.([a-f0-9-]{36})$/.exec(name);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
      activeRuns.add(match[2]!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        await unlink(join(directory, name)).catch(() => {});
      else activeRuns.add(match[2]!);
    }
  }
  const protectedFiles = new Set<string>();
  for (const id of activeRuns) {
    const latest = files.filter((file) => file.name.startsWith(`covro.${id}.`)).at(-1);
    if (latest) protectedFiles.add(latest.path);
  }
  for (const file of files) {
    // Never unlink another live process's active file. Its own writer handles rotation.
    if (protectedFiles.has(file.path)) continue;
    if (file.mtimeMs >= cutoff && total <= options.maxTotalBytes) continue;
    await unlink(file.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    total -= file.size;
  }
}

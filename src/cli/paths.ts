import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const packageInfo = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  engines: { node: string };
  covroCodex?: unknown;
  covroDatabase?: unknown;
  covroCommit?: string;
  covroChannel?: 'stable' | 'beta' | 'dev';
};
export function paths(configPath?: string) {
  const home = resolve(process.env.COVRO_HOME ?? join(homedir(), '.covro'));
  const config = resolve(configPath ?? join(home, 'config.json'));
  const key = createHash('sha256').update(config).digest('hex').slice(0, 16);
  const state = join(home, 'instances', key);
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\covro-${key}` : join(home, `c-${key}.sock`);
  return {
    home,
    config,
    key,
    state,
    socket,
    log: join(state, 'covro.log'),
    logs: join(state, 'logs'),
  };
}
export type CovroPaths = ReturnType<typeof paths>;
export async function writeJson(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}
export async function ensureConfig(location: CovroPaths) {
  await mkdir(location.home, { recursive: true, mode: 0o700 });
  await chmod(location.home, 0o700);
  await mkdir(dirname(location.config), { recursive: true, mode: 0o700 });
  try {
    await readFile(location.config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(
      location.config,
      `${JSON.stringify(
        {
          host: '127.0.0.1',
          port: 8787,
          publicOrigin: ['http://127.0.0.1:8787', 'http://localhost:8787'],
          dataDir: './data',
          codex: { binary: process.env.COVRO_CODEX_BINARY ?? 'codex' },
          projects: [],
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    ).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'EEXIST') throw failure;
    });
  }
}

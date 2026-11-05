import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { verifyDatabaseContract } from '../../scripts/verify-database-contract.js';
import { parseArguments } from '../../src/cli/main.js';

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('parses default background and explicit configuration without forwarding unknown flags', () => {
  expect(parseArguments([]).command).toBe('start');
  expect(parseArguments(['status', '--config', '/tmp/covro-config.json']).location.config).toBe(
    '/tmp/covro-config.json',
  );
  expect(() => parseArguments(['--config'])).toThrow('Unknown argument');
  expect(() => parseArguments(['start', '--prefix', '/tmp/other'])).toThrow('Unknown argument');
});

// Repeated cold CLI starts plus real backup/restore need more than the default 15s on CI.
it('runs the real daemon, reuses its private control socket, and preserves its database on stop', async () => {
  // The production entry is built by the package verification job, not fetched from npm.
  const root = await mkdtemp(join(tmpdir(), 'covro-cli-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  const config = join(root, 'config.json');
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    config,
    JSON.stringify({
      port: address.port,
      publicOrigin: [origin],
      dataDir: './data',
      codex: { binary: join(root, 'missing-codex') },
    }),
  );
  // tsx exercises precisely the same source entry without relying on a stale dist build.
  const entry = resolve('tests/fixtures/covro-cli.mjs');
  const env = { ...process.env, COVRO_HOME: join(root, 'home') };
  const cli = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', entry, ...args, '--config', config], { env });
  cleanups.push(async () => {
    await cli('stop');
  });
  const foreground = spawn(
    process.execPath,
    ['--import', 'tsx', entry, 'run', '--config', config],
    { env, stdio: 'pipe' },
  );
  cleanups.push(async () => {
    if (foreground.exitCode === null) {
      foreground.kill('SIGTERM');
      await once(foreground, 'exit');
    }
  });
  let first: { pid: number; logging?: { directory: string; mode: string } } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const result = await cli('status');
      first = JSON.parse(result.stdout) as { pid: number };
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  expect(first?.pid).toBe(foreground.pid);
  expect(first?.logging).toMatchObject({
    mode: 'file',
    directory: expect.stringContaining('logs'),
  });
  const logs = (await cli('logs', '--event', 'daemon.ready', '--json')).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(logs).toContainEqual(expect.objectContaining({ event: 'daemon.ready' }));
  const again = JSON.parse((await cli('start')).stdout) as { pid: number };
  expect(again.pid).toBe(first?.pid);
  expect((await fetch(`${origin}/api/projects`)).ok).toBe(true);
  const backup = JSON.parse((await cli('backup', 'create')).stdout) as {
    id: string;
    phase: string;
  };
  expect(backup.phase).toBe('succeeded');
  const list = JSON.parse((await cli('backup', 'list')).stdout) as { records: { id: string }[] };
  expect(list.records.some((record) => record.id === backup.id)).toBe(true);
  await expect(cli('backup', 'restore', backup.id, '--confirm', backup.id)).rejects.toThrow(
    'covro stop',
  );
  await cli('stop');
  if (foreground.exitCode === null) await once(foreground, 'exit');
  expect((await cli('status')).stdout).toContain('未运行');
  expect((await cli('logs', '--event', 'gateway.stopped', '--json')).stdout).toContain(
    'gateway.stopped',
  );
  expect(JSON.parse((await cli('backup', 'verify', backup.id)).stdout).schemaVersion).toBe(
    verifyDatabaseContract().schemaVersion,
  );
  const preview = JSON.parse((await cli('backup', 'restore', backup.id)).stdout);
  expect(preview.backupId).toBe(backup.id);
  const restored = JSON.parse(
    (await cli('backup', 'restore', backup.id, '--confirm', backup.id)).stdout,
  );
  expect(restored.restored).toBe(true);
  expect((await readFile(join(root, 'data/app.sqlite'))).length).toBeGreaterThan(0);
}, 60_000);

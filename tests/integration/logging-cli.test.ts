import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { parseArguments } from '../../src/cli/main.js';
import { readLogs, parseSince } from '../../src/cli/logs.js';
import { loggingOptions } from '../../src/logging/config.js';
import { trimBootstrap } from '../../src/logging/bootstrap.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'covro-log-cli-'));
  roots.push(root);
  return root;
}
const filename = (root: string, n: number) =>
  join(root, `covro.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.2026-11-05.${n}.jsonl`);
const record = (n: number, fields = {}) =>
  JSON.stringify({
    time: new Date(1793864000000 + n).toISOString(),
    level: 40,
    event: 'thread_title.finished',
    threadId: 'source',
    count: n,
    ...fields,
  }) + '\n';

it('validates log flags and preserves other CLI command parsing', () => {
  expect(
    parseArguments([
      'logs',
      '--follow',
      '--json',
      '--thread',
      'source',
      '--level',
      'warn',
      '--event',
      'thread_title.finished',
      '--since',
      '1h',
      '--lines',
      '50',
    ]).logQuery,
  ).toMatchObject({ follow: true, json: true, thread: 'source', level: 'warn', lines: 50 });
  for (const args of [
    ['status', '--json'],
    ['logs', '--level', 'everything'],
    ['logs', '--lines', '0'],
    ['logs', '--since', 'yesterday'],
    ['logs', '--thread'],
  ])
    expect(() => parseArguments(args)).toThrow();
  expect(parseSince('1h', 7200000)).toBe(3600000);
  expect(parseSince('2026-11-05T00:00:00Z')).toBe(Date.parse('2026-11-05T00:00:00Z'));
  expect(() => loggingOptions('/tmp', 'test', { COVRO_LOG_MAX_TOTAL_BYTES: '1' })).toThrow();
});

it('filters and orders records across files, with bounded tail and malformed lines ignored', async () => {
  const root = await directory();
  await writeFile(
    filename(root, 1),
    record(3) +
      'invalid\n' +
      record(1) +
      record(4, { threadId: 'temporary', sourceThreadId: 'source' }),
  );
  await writeFile(
    filename(root, 2),
    record(2) + record(5, { threadId: 'other' }) + record(6, { level: 20 }),
  );
  const lines: string[] = [];
  await readLogs(root, { thread: 'source', level: 'warn', json: true, lines: 2 }, (line) =>
    lines.push(line),
  );
  expect(lines.map((line) => JSON.parse(line).count)).toEqual([3, 4]);
  const missing: string[] = [];
  await readLogs(join(root, 'absent'), {}, (line) => missing.push(line));
  expect(missing).toEqual([]);
});

it('follows byte offsets through split UTF-8 records, rotation and replacement without duplicates', async () => {
  const root = await directory();
  const file = filename(root, 1);
  await writeFile(file, record(1));
  const controller = new AbortController();
  const lines: string[] = [];
  const following = readLogs(
    root,
    { follow: true, json: true },
    (line) => lines.push(line),
    controller.signal,
  );
  try {
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const bytes = Buffer.from(record(2, { stage: '验证' }));
    const split = bytes.indexOf(Buffer.from('验')) + 1;
    await appendFile(file, bytes.subarray(0, split));
    await new Promise((done) => setTimeout(done, 250));
    expect(lines).toHaveLength(1);
    await appendFile(file, bytes.subarray(split));
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    await writeFile(filename(root, 2), record(3));
    await vi.waitFor(() => expect(lines).toHaveLength(3));
    await rm(file);
    await writeFile(file, record(4));
    await vi.waitFor(() => expect(lines).toHaveLength(4));
    expect(lines.map((line) => JSON.parse(line).count)).toEqual([1, 2, 3, 4]);
  } finally {
    controller.abort();
    await following;
  }
});

it('bounds the legacy bootstrap file without renaming a service-owned file', async () => {
  const root = await directory();
  const file = join(root, 'covro.log');
  await writeFile(file, 'a'.repeat(500) + 'tail');
  await trimBootstrap(file, 200, 4);
  expect(await readFile(file, 'utf8')).toBe('tail');
  await appendFile(file, 'new');
  expect(await readFile(file, 'utf8')).toBe('tailnew');
});

it('flushes a safe fatal record and exits without printing secret exception content', async () => {
  const root = await directory();
  const source = `import { createLogging } from ${JSON.stringify(resolve('src/logging/logger.ts'))};
import { monitorCrashes } from ${JSON.stringify(resolve('src/logging/lifecycle.ts'))};
const log = await createLogging({directory:process.argv[1],version:'test'});
monitorCrashes(log.logger,log.flushSync);
setImmediate(()=>{throw new Error('SECRET_EXCEPTION')});`;
  let code: number | undefined;
  try {
    await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      source,
      root,
    ]);
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    code = failure.code;
    expect(failure.stderr).not.toContain('SECRET_EXCEPTION');
  }
  expect(code).toBe(1);
  const lines: string[] = [];
  await readLogs(root, { json: true }, (line) => lines.push(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('process.uncaught_exception');
  expect(lines[0]).not.toContain('SECRET_EXCEPTION');
});

it('continues safely when both the log file and fallback stderr are unavailable', async () => {
  const root = await directory();
  const file = join(root, 'file');
  await writeFile(file, 'x');
  const source = `import { closeSync } from 'node:fs';
import { createLogging } from ${JSON.stringify(resolve('src/logging/logger.ts'))};
closeSync(2);
const log = await createLogging({directory:process.argv[1],version:'test'});
log.logger.error('test.failed');
await log.close();
process.stdout.write(JSON.stringify(log.health()));`;
  const result = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    source,
    join(file, 'logs'),
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'stderr', errorCode: 'LOG_INIT_FAILED' });
});

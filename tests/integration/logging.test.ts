import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, utimes, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { createLogging, wrapLogger, logLevel } from '../../src/logging/logger.js';
import { withLogContext } from '../../src/logging/context.js';
import { errorFields } from '../../src/logging/fields.js';
import { cleanLogs, logFiles } from '../../src/logging/retention.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'covro-logging-'));
  roots.push(root);
  return root;
}

it('isolates asynchronous request contexts and rejects content, credentials and arbitrary error text', async () => {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const log = wrapLogger(pino({ level: 'debug', base: null }, output), { component: 'test' });
  await Promise.all(
    ['request-a', 'request-b'].map((requestId, i) =>
      withLogContext({ requestId }, async () => {
        await new Promise((done) => setTimeout(done, i === 0 ? 10 : 1));
        log.child({ threadId: `thread-${i}` }).info('test.completed', {
          stage: 'generation',
          prompt: 'SECRET_PROMPT',
          title: 'PRIVATE_TITLE',
          token: 'SECRET_TOKEN',
          headers: { authorization: 'SECRET_AUTH' },
          ...errorFields(
            Object.assign(new Error('SECRET_ERROR'), {
              code: 'ECONNRESET',
              details: 'SECRET_DETAILS',
            }),
          ),
        });
      }),
    ),
  );
  expect(lines.join('')).not.toMatch(/SECRET|PRIVATE/);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      requestId: 'request-b',
      threadId: 'thread-1',
      errorCode: 'ECONNRESET',
    }),
    expect.objectContaining({ requestId: 'request-a', threadId: 'thread-0', stage: 'generation' }),
  ]);
  log.info('test.bad\nevent', {});
  log.info('test.safe', {
    threadId: 'https://secret',
    durationMs: Infinity,
    errorCode: 'abc\nsecret',
  });
  expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('threadId');
  expect(lines).toHaveLength(3);
});

it('writes private JSONL, flushes at shutdown, rotates and prunes previous process logs', async () => {
  const root = await directory();
  const logging = await createLogging({
    directory: root,
    version: 'test',
    level: 'debug',
    maxFileBytes: 300,
    maxTotalBytes: 1600,
  });
  try {
    for (let i = 0; i < 25; i++) {
      logging.logger.info('test.completed', { threadId: `thread-${i}`, durationMs: i });
      await new Promise((done) => setTimeout(done, 2));
    }
  } finally {
    await logging.close();
  }
  const files = await logFiles(root);
  expect(files.length).toBeGreaterThan(1);
  expect(files.reduce((size, file) => size + file.size, 0)).toBeLessThanOrEqual(1600);
  const records = (await Promise.all(files.map((file) => readFile(file.path, 'utf8'))))
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records).toContainEqual(
    expect.objectContaining({ event: 'test.completed', threadId: 'thread-24' }),
  );
  if (process.platform !== 'win32') {
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    for (const file of files) expect((await stat(file.path)).mode & 0o777).toBe(0o600);
  }
  expect(logging.health().mode).toBe('file');
});

it('retains live writer files while removing aged logs and never touches unrelated files or symlinks', async () => {
  const root = await directory();
  const active = await createLogging({ directory: root, version: 'test' });
  active.logger.info('test.active');
  const old = join(root, 'covro.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.2020-01-01.1.jsonl');
  await writeFile(old, 'old');
  await utimes(old, new Date(0), new Date(0));
  const unrelated = join(root, 'notes.jsonl');
  await writeFile(unrelated, 'keep');
  const link = join(root, 'covro.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.2020-01-01.1.jsonl');
  await symlink(unrelated, link);
  try {
    await vi.waitFor(async () => expect((await logFiles(root)).length).toBe(2));
    await cleanLogs(root, { maxAgeDays: 14, maxTotalBytes: 1 });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    expect(await readFile(link, 'utf8')).toBe('keep');
    expect((await logFiles(root)).some((file) => file.path === old)).toBe(false);
    expect((await logFiles(root)).some((file) => file.name.includes(active.health().runId))).toBe(
      true,
    );
  } finally {
    await active.close();
  }
});

it('degrades safely on file initialization failure and rate limits fallback records', async () => {
  const root = await directory();
  const file = join(root, 'file');
  await writeFile(file, 'x');
  const lines: string[] = [];
  const logging = await createLogging({
    directory: join(file, 'logs'),
    version: 'test',
    fallback: (line) => lines.push(line),
  });
  for (let i = 0; i < 100; i++)
    logging.logger.error('test.failed', { prompt: 'SECRET', errorCode: 'TEST_FAILED' });
  await logging.close();
  expect(logging.health()).toMatchObject({ mode: 'stderr', errorCode: 'LOG_INIT_FAILED' });
  expect(lines.length).toBe(1);
  expect(lines.join('')).not.toContain('SECRET');
});

it('bounds buffered writes and reports dropped records', async () => {
  const root = await directory();
  const lines: string[] = [];
  const logging = await createLogging({
    directory: root,
    version: 'test',
    maxBufferBytes: 20,
    fallback: (line) => lines.push(line),
  });
  logging.logger.debug('test.filtered');
  logging.logger.info('test.over_budget');
  await logging.close();
  expect(logging.health().droppedRecords).toBeGreaterThan(0);
  expect(lines.join('')).toContain('logging.records_dropped');
});

it('validates the configured level instead of silently enabling verbose output', () => {
  expect(logLevel({ COVRO_LOG_LEVEL: 'debug' })).toBe('debug');
  expect(() => logLevel({ COVRO_LOG_LEVEL: 'all' })).toThrow('COVRO_LOG_LEVEL');
});

it('degrades on an asynchronous disk error without exposing error text or failing the caller', async () => {
  const root = await directory();
  const lines: string[] = [];
  const logging = await createLogging({
    directory: root,
    version: 'test',
    fallback: (line) => lines.push(line),
  });
  const write = vi.spyOn(fs, 'write');
  write.mockImplementationOnce(((...args: unknown[]) => {
    const callback = args.findLast((value) => typeof value === 'function') as (
      error: Error,
    ) => void;
    queueMicrotask(() =>
      callback(Object.assign(new Error('SECRET_DISK_ERROR'), { code: 'ENOSPC' })),
    );
  }) as typeof fs.write);
  try {
    expect(() => logging.logger.info('test.disk_error', { prompt: 'SECRET_PROMPT' })).not.toThrow();
    await vi.waitFor(() =>
      expect(logging.health()).toMatchObject({ mode: 'stderr', errorCode: 'ENOSPC' }),
    );
    expect(lines.join('')).toContain('logging.write_failed');
    expect(lines.join('')).not.toContain('SECRET');
  } finally {
    write.mockRestore();
    await logging.close();
  }
});

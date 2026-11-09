import pino from 'pino';
import roll from 'pino-roll';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logContext } from './context.js';
import { safeFields, type LogFields } from './fields.js';
import { cleanLogs } from './retention.js';

export const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof levels)[number];
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}
const noop = () => {};
export const nullLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => nullLogger,
};
export interface LogHealth {
  mode: 'file' | 'stderr';
  directory: string;
  runId: string;
  droppedRecords: number;
  errorCode?: string;
}
export interface LoggingOptions {
  directory: string;
  version: string;
  component?: string;
  level?: LogLevel;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxAgeDays?: number;
  maxBufferBytes?: number;
  /** Testing/embedding hook: receives sanitized records only. */
  fallback?: (line: string) => void;
}
export function wrapLogger(output: pino.Logger, bindings: LogFields = {}): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (!/^[a-z][a-z0-9_.]{0,99}$/.test(event)) return;
    output[level]({
      ...safeFields({ ...logContext() }),
      ...safeFields(bindings),
      ...safeFields(fields),
      event,
    });
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    fatal: (event, fields) => write('fatal', event, fields),
    child: (fields) => wrapLogger(output, { ...bindings, ...safeFields(fields) }),
  };
}
export async function createLogging(options: LoggingOptions) {
  const runId = randomUUID();
  const marker = join(options.directory, `.active.${process.pid}.${runId}`);
  const health: LogHealth = {
    mode: 'file',
    directory: options.directory,
    runId,
    droppedRecords: 0,
  };
  const fallback =
    options.fallback ??
    ((line: string) => {
      process.stderr.write(line);
    });
  let lastFallback = 0;
  let closed = false;
  const report = (errorCode: string) => {
    health.mode = 'stderr';
    health.errorCode = errorCode;
    if (Date.now() - lastFallback < 10_000) return;
    lastFallback = Date.now();
    try {
      fallback(
        JSON.stringify({
          time: new Date().toISOString(),
          level: 50,
          event: 'logging.write_failed',
          runId,
          errorCode,
        }) + '\n',
      );
    } catch {
      /* Logging never fails a user operation. */
    }
  };
  let stream: Awaited<ReturnType<typeof roll>> | undefined;
  const cleanup = () =>
    cleanLogs(options.directory, {
      maxAgeDays: options.maxAgeDays ?? 14,
      maxTotalBytes: options.maxTotalBytes ?? 200 * 1024 * 1024,
      activeRunIds: [runId],
    });
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700);
    await cleanup();
    await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
    stream = await roll({
      file: join(options.directory, `covro.${runId}.jsonl`),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      size: `${options.maxFileBytes ?? 10 * 1024 * 1024}b`,
      mkdir: true,
      mode: 0o600,
      sync: false,
      maxLength: options.maxBufferBytes ?? 1024 * 1024,
    });
    stream.on('error', (error: NodeJS.ErrnoException) =>
      report(/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code! : 'LOG_WRITE_FAILED'),
    );
    stream.on('drop', () => {
      health.droppedRecords++;
      if (Date.now() - lastFallback < 10_000) return;
      lastFallback = Date.now();
      try {
        fallback(
          JSON.stringify({
            time: new Date().toISOString(),
            level: 40,
            event: 'logging.records_dropped',
            runId,
            droppedRecords: health.droppedRecords,
          }) + '\n',
        );
      } catch {
        /* Best effort. */
      }
    });
    if (stream.fd < 0)
      await new Promise<void>((resolve, reject) => {
        stream!.once('ready', resolve);
        stream!.once('error', reject);
      });
    stream.on('ready', () => {
      void cleanup().catch(() => report('LOG_CLEANUP_FAILED'));
    });
  } catch {
    report('LOG_INIT_FAILED');
  }
  const destination = {
    write(line: string) {
      if (closed) return;
      if (stream && health.mode === 'file') {
        try {
          stream.write(line);
        } catch {
          report('LOG_WRITE_FAILED');
        }
      } else {
        // On failure emit bounded safe error records, rather than queue indefinitely.
        health.droppedRecords++;
        if (/"level":(?:40|50|60)/.test(line) && Date.now() - lastFallback >= 1000) {
          lastFallback = Date.now();
          try {
            fallback(line);
          } catch {
            /* Best effort. */
          }
        }
      }
    },
  };
  const output = pino(
    {
      level: options.level ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid, version: options.version, runId },
    },
    destination,
  );
  const logger = wrapLogger(output, { component: options.component ?? 'gateway' });
  const timer = setInterval(() => {
    void cleanup().catch(() => report('LOG_CLEANUP_FAILED'));
  }, 60_000);
  timer.unref();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      if (!stream || stream.destroyed) {
        closed = true;
        await unlink(marker).catch(() => {});
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          stream!.destroy();
          resolve();
        }, 3000);
        const done = () => {
          clearTimeout(timeout);
          resolve();
        };
        stream!.once('close', done);
        stream!.once('error', done);
        try {
          stream!.end();
        } catch {
          done();
        }
      });
      closed = true;
      await unlink(marker).catch(() => {});
      await cleanup().catch(() => report('LOG_CLEANUP_FAILED'));
    })());
  return { logger, health: () => ({ ...health }), close };
}
export function logLevel(env = process.env): LogLevel {
  const value = env.COVRO_LOG_LEVEL ?? 'info';
  if (!levels.includes(value as LogLevel))
    throw new Error('COVRO_LOG_LEVEL must be debug, info, warn, error or fatal');
  return value as LogLevel;
}

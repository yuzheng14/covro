import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { logFiles } from '../logging/retention.js';
import { levels, type LogLevel } from '../logging/logger.js';

export interface LogQuery {
  follow?: boolean;
  json?: boolean;
  thread?: string;
  event?: string;
  level?: LogLevel;
  since?: number;
  lines?: number;
}
type RecordLine = Record<string, unknown> & { time: string; level: number; event: string };
const severity = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const names = new Map(Object.entries(severity).map(([name, value]) => [value, name]));
const maxLineBytes = 16 * 1024;

export function parseSince(value: string, now = Date.now()): number {
  const duration = /^(\d+)([mhd])$/.exec(value);
  const time = duration
    ? now - Number(duration[1]) * { m: 60000, h: 3600000, d: 86400000 }[duration[2]!]!
    : /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(time) || time < 0)
    throw new Error('--since requires a duration such as 1h or an ISO timestamp with timezone');
  return time;
}
export function validateQuery(query: LogQuery) {
  if (query.level && !levels.includes(query.level)) throw new Error('Invalid --level');
  if (
    query.lines !== undefined &&
    (!Number.isInteger(query.lines) || query.lines < 1 || query.lines > 10000)
  )
    throw new Error('--lines must be between 1 and 10000');
  if (query.thread && !/^[a-zA-Z0-9_.:-]{1,160}$/.test(query.thread))
    throw new Error('Invalid --thread');
  if (query.event && !/^[a-z][a-z0-9_.]{0,99}$/.test(query.event))
    throw new Error('Invalid --event');
}
function matches(record: RecordLine, query: LogQuery) {
  return (
    (!query.level || record.level >= severity[query.level]) &&
    (!query.thread || [record.threadId, record.sourceThreadId].includes(query.thread)) &&
    (!query.event || record.event === query.event) &&
    (query.since === undefined || Date.parse(record.time) >= query.since)
  );
}
function parseRecord(line: string): RecordLine | undefined {
  try {
    const record = JSON.parse(line) as RecordLine;
    if (
      record &&
      typeof record.time === 'string' &&
      Number.isFinite(Date.parse(record.time)) &&
      typeof record.level === 'number' &&
      typeof record.event === 'string' &&
      /^[a-z][a-z0-9_.]{0,99}$/.test(record.event)
    )
      return record;
  } catch {
    /* Incomplete/malformed records are never fatal to the reader. */
  }
}
export function formatRecord(record: RecordLine, json = false): string {
  if (json) return JSON.stringify(record);
  const fields = Object.entries(record).filter(
    ([key]) => !['time', 'level', 'event', 'pid', 'version', 'runId'].includes(key),
  );
  return `${record.time} ${(names.get(record.level) ?? String(record.level)).toUpperCase()} ${record.event} ${fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`.trimEnd();
}

/** Read by bytes: an incomplete UTF-8/JSON line is revisited on the next follow poll. */
async function scan(
  path: string,
  previous: { offset: number; inode: string } | undefined,
  consume: (record: RecordLine) => void,
) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return { offset: 0, inode: '' };
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return { offset: 0, inode: '' };
    const inode = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const offset =
      previous && previous.inode === inode && previous.offset <= stat.size ? previous.offset : 0;
    let position = offset;
    let completeThrough = offset;
    let pending = Buffer.alloc(0);
    let oversized = false;
    const buffer = Buffer.alloc(64 * 1024);
    while (position < stat.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (!bytesRead) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        const part = buffer.subarray(start, i);
        if (!oversized && pending.length + part.length <= maxLineBytes) {
          const record = parseRecord(Buffer.concat([pending, part]).toString('utf8'));
          if (record) await consume(record);
        }
        pending = Buffer.alloc(0);
        oversized = false;
        start = i + 1;
        completeThrough = position + start;
      }
      const tail = buffer.subarray(start, bytesRead);
      if (pending.length + tail.length > maxLineBytes) {
        pending = Buffer.alloc(0);
        oversized = true;
      } else if (!oversized) pending = Buffer.concat([pending, tail]);
      position += bytesRead;
    }
    return { offset: completeThrough, inode };
  } finally {
    await file.close();
  }
}

export async function readLogs(
  directory: string,
  query: LogQuery,
  write: (line: string) => void,
  signal?: AbortSignal,
) {
  validateQuery(query);
  const cursors = new Map<string, { offset: number; inode: string }>();
  const limit = query.lines ?? 200;
  let records: RecordLine[] = [];
  const trim = () => {
    records.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    records = records.slice(-limit);
  };
  for (const file of await logFiles(directory)) {
    const cursor = await scan(file.path, undefined, (record) => {
      if (!matches(record, query)) return;
      records.push(record);
      if (records.length >= limit * 2) trim();
    });
    cursors.set(file.path, cursor);
  }
  trim();
  for (const record of records) await write(formatRecord(record, query.json));
  if (!query.follow) return;
  while (!signal?.aborted) {
    const files = await logFiles(directory);
    const paths = new Set(files.map((file) => file.path));
    for (const path of cursors.keys()) if (!paths.has(path)) cursors.delete(path);
    for (const file of files) {
      const previous = cursors.get(file.path);
      cursors.set(
        file.path,
        await scan(file.path, previous, (record) => {
          if (matches(record, query)) return write(formatRecord(record, query.json));
        }),
      );
    }
    try {
      await setTimeout(200, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
}

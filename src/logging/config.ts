import type { LoggingOptions } from './logger.js';
import { logLevel } from './logger.js';

export function loggingOptions(
  directory: string,
  version: string,
  env = process.env,
): LoggingOptions {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const text = env[name];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  const maxFileBytes = integer(
    'COVRO_LOG_MAX_FILE_BYTES',
    10 * 1024 * 1024,
    256,
    1024 * 1024 * 1024,
  );
  const maxTotalBytes = integer(
    'COVRO_LOG_MAX_TOTAL_BYTES',
    200 * 1024 * 1024,
    256,
    10 * 1024 * 1024 * 1024,
  );
  if (maxTotalBytes < maxFileBytes)
    throw new Error('COVRO_LOG_MAX_TOTAL_BYTES must be at least COVRO_LOG_MAX_FILE_BYTES');
  return {
    directory,
    version,
    level: logLevel(env),
    maxFileBytes,
    maxTotalBytes,
    maxAgeDays: integer('COVRO_LOG_MAX_AGE_DAYS', 14, 1, 365),
    maxBufferBytes: integer('COVRO_LOG_MAX_BUFFER_BYTES', 1024 * 1024, 4096, 64 * 1024 * 1024),
  };
}

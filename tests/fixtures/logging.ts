import pino from 'pino';
import { Writable } from 'node:stream';
import { wrapLogger } from '../../src/logging/logger.js';

export function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      records.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      done();
    },
  });
  return { logger: wrapLogger(pino({ level: 'debug', base: null }, destination)), records };
}

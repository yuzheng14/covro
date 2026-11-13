import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { logContext } from '../logging/context.js';
import { EventEmitter } from 'node:events';
import { AppError } from '../shared/errors.js';
import type { Readable, Writable } from 'node:stream';

export type RpcId = string | number;
export type RpcNotification = { method: string; params?: unknown };
export type RpcServerRequest = RpcNotification & { id: RpcId };
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
export class CodexError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly uncertain = false,
    public readonly rpcCode?: number,
    diagnostics?: Record<string, unknown>,
  ) {
    super(code, message, 503, { uncertain, rpcCode, ...diagnostics });
    this.name = 'CodexError';
  }
}

/** Buffers at most one bounded line. Decoding the complete byte sequence preserves split UTF-8. */
export class JsonLineReader {
  private parts: Buffer[] = [];
  private size = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(
    private readonly consume: (value: unknown) => void,
    private readonly maxBytes = DEFAULT_MAX_LINE_BYTES,
  ) {}
  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.size += part.length;
      if (this.size > this.maxBytes) {
        const receivedBytes = this.size;
        this.parts = [];
        this.size = 0;
        throw new CodexError(
          'PROTOCOL_ERROR',
          `Codex JSONL message exceeds the configured limit (received at least ${receivedBytes} bytes; limit ${this.maxBytes} bytes)`,
          true,
          undefined,
          { receivedBytes, maxLineBytes: this.maxBytes },
        );
      }
      if (part.length) this.parts.push(part);
      if (newline < 0) break;
      this.flush();
      start = newline + 1;
    }
  }
  finish(): void {
    if (this.size) this.flush();
  }
  private flush(): void {
    const bytes = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    try {
      const line = this.decoder.decode(bytes).trim();
      if (line) this.consume(JSON.parse(line) as unknown);
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError('PROTOCOL_ERROR', 'Invalid UTF-8 or JSON from Codex', true);
    }
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
export type TransportOptions = {
  logger?: Logger;
  timeoutMs?: number;
  maxLineBytes?: number;
  maxPending?: number;
  maxWriteBytes?: number;
};

/** RPC receipt deadlines do not cancel upstream turns. A timeout always reports an uncertain outcome. */
export class RpcTransport extends EventEmitter {
  private readonly pending = new Map<RpcId, Pending>();
  private nextId = 0;
  private failure?: CodexError;
  private readonly reader: JsonLineReader;
  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly options: TransportOptions = {},
  ) {
    super();
    this.reader = new JsonLineReader((value) => this.receive(value), options.maxLineBytes);
    output.on('data', (chunk: Buffer) => {
      if (this.failure) return;
      try {
        this.reader.push(chunk);
      } catch (error) {
        this.fail(asCodexError(error));
      }
    });
    output.on('end', () => {
      if (this.failure) return;
      try {
        this.reader.finish();
      } catch (error) {
        this.fail(asCodexError(error));
      }
      this.fail(new CodexError('CODEX_UNAVAILABLE', 'Codex stdout reached EOF', true));
    });
    output.on('close', () =>
      this.fail(new CodexError('CODEX_UNAVAILABLE', 'Codex stdout closed', true)),
    );
    output.on('error', (error) =>
      this.fail(new CodexError('CODEX_UNAVAILABLE', error.message, true)),
    );
    input.on('error', (error) =>
      this.fail(new CodexError('CODEX_UNAVAILABLE', error.message, true)),
    );
  }
  request<T>(
    method: string,
    params: unknown,
    id: RpcId = this.nextId++,
    timeoutMs = this.options.timeoutMs ?? 30_000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.has(id))
      return Promise.reject(new CodexError('PROTOCOL_ERROR', 'Duplicate outgoing RPC id'));
    if (this.pending.size >= (this.options.maxPending ?? 256))
      return Promise.reject(new CodexError('CODEX_BUSY', 'Too many pending Codex requests'));
    const logger = (this.options.logger ?? nullLogger).child({
      ...logContext(),
      method,
      rpcId: id,
      ...(isRecord(params) ? { threadId: params.threadId } : {}),
    });
    const started = performance.now();
    logger.debug('rpc.started');
    return new Promise<T>((resolve, reject) => {
      const rejectLogged = (error: Error) => {
        logger.warn('rpc.failed', {
          ...errorFields(error),
          durationMs: Math.round(performance.now() - started),
        });
        reject(error);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectLogged(
          new CodexError(
            'RESULT_UNKNOWN',
            `Codex ${method} acknowledgement timed out; it may have executed`,
            true,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        reject: rejectLogged,
        resolve: (result) => {
          logger.debug('rpc.completed', { durationMs: Math.round(performance.now() - started) });
          resolve(result as T);
        },
      });
      void this.write({ id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(asCodexError(error));
      });
    });
  }
  notify(method: string, params?: unknown): Promise<void> {
    return this.write({ method, ...(params === undefined ? {} : { params }) });
  }
  respond(id: RpcId, result: unknown): Promise<void> {
    return this.write({ id, result });
  }
  reject(id: RpcId, code: number, message: string): Promise<void> {
    return this.write({ id, error: { code, message } });
  }
  fail(error: CodexError): void {
    if (this.failure) return;
    error = new CodexError(error.code, error.message, error.uncertain, error.rpcCode, {
      ...(isRecord(error.details) ? error.details : {}),
      pendingRequests: [...this.pending].map(([id, pending]) => ({ id, method: pending.method })),
    });
    this.failure = error;
    (this.options.logger ?? nullLogger).error('rpc.transport_failed', {
      ...errorFields(error),
      pendingRequests: this.pending.size,
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }
  private async write(message: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    const data = JSON.stringify(message) + '\n';
    if (this.input.destroyed || !this.input.writable)
      throw new CodexError('CODEX_UNAVAILABLE', 'Codex stdin is closed', true);
    // Backpressure bounds queued writes, not the size of an individual image message.
    if (this.input.writableLength > (this.options.maxWriteBytes ?? 4 * 1024 * 1024)) {
      throw new CodexError('CODEX_BUSY', 'Codex stdin buffer limit reached');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new CodexError('RESULT_UNKNOWN', 'Codex stdin write timed out', true);
        this.fail(error);
        reject(error);
      }, this.options.timeoutMs ?? 30_000);
      this.input.write(data, (error) => {
        clearTimeout(timer);
        if (error) reject(new CodexError('CODEX_UNAVAILABLE', error.message, true));
        else resolve();
      });
    });
  }
  private receive(value: unknown): void {
    if (!isRecord(value))
      throw new CodexError('PROTOCOL_ERROR', 'Codex sent a non-object RPC message', true);
    const hasId = Object.hasOwn(value, 'id');
    if (hasId && !isRpcId(value.id))
      throw new CodexError('PROTOCOL_ERROR', 'Codex sent an invalid RPC id', true);
    if (typeof value.method === 'string') {
      if (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))
        throw new CodexError('PROTOCOL_ERROR', 'Codex mixed a method and RPC result', true);
      if (hasId) this.emit('request', value as RpcServerRequest);
      else this.emit('notification', value as RpcNotification);
      return;
    }
    if (!hasId || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error'))
      throw new CodexError('PROTOCOL_ERROR', 'Unrecognized Codex RPC message', true);
    const pending = this.pending.get(value.id as RpcId);
    if (!pending) return; // Late receipts after a timeout must never cause a prompt to be resent.
    this.pending.delete(value.id as RpcId);
    clearTimeout(pending.timer);
    if (Object.hasOwn(value, 'error')) {
      if (
        !isRecord(value.error) ||
        typeof value.error.message !== 'string' ||
        typeof value.error.code !== 'number'
      ) {
        const error = new CodexError('PROTOCOL_ERROR', 'Malformed Codex RPC error', true);
        pending.reject(error);
        throw error;
      }
      pending.reject(
        new CodexError(
          value.error.code === -32601 ? 'PROTOCOL_INCOMPATIBLE' : 'CODEX_REQUEST_FAILED',
          value.error.message,
          false,
          value.error.code,
          modelProviderDiagnostics(value.error.data),
        ),
      );
    } else pending.resolve(value.result);
  }
}
/** Only public provider identifiers cross the gateway; arbitrary RPC data may contain secrets. */
function modelProviderDiagnostics(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return;
  const fields =
    data.type === 'modelProviderMismatch'
      ? ['modelProvider', 'currentModelProvider']
      : data.type === 'modelProviderPolicyConflict'
        ? ['modelProvider', 'requiredModelProvider']
        : data.type === 'modelProviderNotConfigured'
          ? ['modelProvider']
          : undefined;
  if (
    !fields ||
    fields.some(
      (field) => typeof data[field] !== 'string' || !data[field] || data[field].length > 256,
    )
  )
    return;
  return {
    modelProviderError: Object.fromEntries([
      ['type', data.type],
      ...fields.map((field) => [field, data[field]]),
    ]),
  };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isRpcId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
export function asCodexError(error: unknown): CodexError {
  return error instanceof CodexError
    ? error
    : new CodexError(
        'CODEX_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        true,
      );
}

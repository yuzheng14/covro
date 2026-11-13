import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonLineReader, RpcTransport } from '../../src/codex/transport.js';

describe('Codex JSONL and bidirectional RPC', () => {
  it.each([
    { type: 'modelProviderMismatch', modelProvider: 'gcp', currentModelProvider: 'openai' },
    { type: 'modelProviderNotConfigured', modelProvider: 'gcp' },
    { type: 'modelProviderPolicyConflict', modelProvider: 'gcp', requiredModelProvider: 'openai' },
  ])(
    'preserves public provider diagnostics for $type without arbitrary error data',
    async (data) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const rpc = new RpcTransport(input, output);
      const pending = rpc.request('thread/resume', {});
      output.write(
        JSON.stringify({
          id: 0,
          error: {
            code: -32600,
            message: 'Restore provider configuration',
            data: { ...data, token: 'private' },
          },
        }) + '\n',
      );
      await expect(pending).rejects.toMatchObject({
        code: 'CODEX_REQUEST_FAILED',
        uncertain: false,
        details: { modelProviderError: data },
      });
      await pending.catch((error) => expect(JSON.stringify(error)).not.toContain('private'));
      input.destroy();
      output.destroy();
    },
  );
  it.each([
    { type: 'unknown', token: 'private' },
    { type: 'modelProviderMismatch', modelProvider: 'gcp' },
    { type: 'modelProviderNotConfigured', modelProvider: 'x'.repeat(257) },
  ])('keeps unknown or malformed provider data out of diagnostics: %j', async (data) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new RpcTransport(input, output);
    const pending = rpc.request('thread/resume', {});
    output.write(
      JSON.stringify({ id: 0, error: { code: -32600, message: 'Provider error', data } }) + '\n',
    );
    await pending.catch((error) => {
      expect(error.message).toBe('Provider error');
      expect(error.details.modelProviderError).toBeUndefined();
    });
    input.destroy();
    output.destroy();
  });
  it('preserves UTF-8 split across every byte, half lines and multiple messages', () => {
    const values: unknown[] = [];
    const reader = new JsonLineReader((value) => values.push(value));
    const bytes = Buffer.from('{"text":"你好，世界"}\n{"id":0,"result":false}\n');
    for (const byte of bytes) reader.push(Buffer.from([byte]));
    expect(values).toEqual([{ text: '你好，世界' }, { id: 0, result: false }]);
  });
  it('matches interleaved responses by original id type and handles numeric zero', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new RpcTransport(input, output);
    const requests: unknown[] = [];
    const notifications: unknown[] = [];
    transport.on('request', (request) => requests.push(request));
    transport.on('notification', (event) => notifications.push(event));
    const numeric = transport.request('a', {}, 0);
    const string = transport.request('b', {}, '0');
    output.write(
      '{"id":"0","result":"second"}\n{"method":"notice","params":{}}\n{"id":0,"method":"approval","params":{}}\n{"id":0,"result":"first"}\n',
    );
    expect(await numeric).toBe('first');
    expect(await string).toBe('second');
    expect(requests).toEqual([{ id: 0, method: 'approval', params: {} }]);
    expect(notifications).toHaveLength(1);
    input.destroy();
    output.destroy();
  });
  it.each(['{broken\n', '{"id":null,"result":1}\n', '{"nothing":true}\n'])(
    'rejects invalid envelopes and fails all waiters: %s',
    async (line) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const rpc = new RpcTransport(input, output);
      const failure = rpc.request('method', {});
      output.write(line);
      await expect(failure).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', uncertain: true });
      input.destroy();
      output.destroy();
    },
  );
  it.each([undefined, 16])(
    'accepts large individual messages and bounds only queued writes (budget %s)',
    async (maxWriteBytes) => {
      const output = new PassThrough();
      let finishWrite = () => {};
      const input = new Writable({
        write(_chunk, _encoding, callback) {
          finishWrite = callback;
        },
      });
      const rpc = new RpcTransport(input, output, { maxWriteBytes });
      const pending = rpc.notify('turn/start', { image: 'x'.repeat(5 * 1024 * 1024) });
      expect(input.writableLength).toBeGreaterThan(5 * 1024 * 1024);
      await expect(rpc.notify('turn/steer', {})).rejects.toMatchObject({
        code: 'CODEX_BUSY',
        uncertain: false,
      });
      finishWrite();
      await pending;
      const next = rpc.notify('turn/steer', {});
      finishWrite();
      await next;
      input.destroy();
      output.destroy();
    },
  );
  it('bounds messages before assembling unlimited input and rejects invalid UTF-8', () => {
    expect(() => new JsonLineReader(() => {}, 16).push(Buffer.alloc(17))).toThrow(
      'configured limit',
    );
    expect(() => new JsonLineReader(() => {}).push(Buffer.from([0xff, 10]))).toThrow(
      'Invalid UTF-8',
    );
  });
  it('reports the byte limit and pending method/ID without request or response contents', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new RpcTransport(input, output, { maxLineBytes: 32 });
    const pending = rpc.request('thread/items/list', { secret: 'private request' }, 7);
    output.write('{"id":7,"result":"private response');
    await expect(pending).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      uncertain: true,
      details: {
        receivedBytes: 34,
        maxLineBytes: 32,
        pendingRequests: [{ id: 7, method: 'thread/items/list' }],
      },
    });
    await pending.catch((error) => expect(JSON.stringify(error)).not.toContain('private'));
    input.destroy();
    output.destroy();
  });
  it('reports RPC timeout as uncertain, without resending or treating it as cancellation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: Buffer[] = [];
    input.on('data', (data: Buffer) => writes.push(data));
    const rpc = new RpcTransport(input, output, { timeoutMs: 10 });
    await expect(rpc.request('turn/start', {})).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
      uncertain: true,
    });
    output.write('{"id":0,"result":{}}\n');
    expect(writes).toHaveLength(1);
    input.destroy();
    output.destroy();
  });
  it('fails EOF and explicit RPC rejections with distinct uncertainty', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new RpcTransport(input, output);
    const rejected = rpc.request('missing', {});
    output.write('{"id":0,"error":{"code":-32601,"message":"not found"}}\n');
    await expect(rejected).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      uncertain: false,
    });
    const eof = rpc.request('waiting', {});
    output.end();
    await expect(eof).rejects.toMatchObject({ code: 'CODEX_UNAVAILABLE', uncertain: true });
    input.destroy();
  });
});

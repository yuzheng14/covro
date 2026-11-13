/** Kernel byte fixtures test parser/security boundaries; real OS coverage is separate. */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('../../bin/process-darwin.js', import.meta.url), 'utf8');
function fixture(entries: string[], options: { reused?: boolean; truncated?: boolean } = {}) {
  const prefix = Buffer.from('/usr/bin/node\0\0node\0CODEX_THREAD_ID=argv-spoof\0');
  const argc = Buffer.alloc(4);
  argc.writeUInt32LE(2);
  let environment = Buffer.concat([argc, prefix, Buffer.from(entries.join('\0') + '\0')]);
  if (options.truncated) environment = environment.subarray(0, -1);
  let infoCalls = 0;
  let environmentMemory: Buffer | undefined;
  const context = createContext({
    ObjC: { import() {}, bindFunction() {} },
    Ref: Object.assign(() => [0], { equals: (a: unknown, b: unknown) => a === b }),
    $: {
      dlopen: () => ({}),
      calloc: (count: number, size: number) => Buffer.alloc(count * size),
      free() {},
      memset: (memory: Buffer, value: number) => memory.fill(value),
      proc_pidinfo(pid: number, flavor: number, _arg: number, memory: Buffer) {
        if (flavor === 3) {
          memory.writeUInt32LE(pid, 12);
          memory.writeUInt32LE(100, 16);
          memory.writeUInt32LE(1700000000 + (options.reused && infoCalls++ > 0 ? 1 : 0), 120);
          memory.writeUInt32LE(123456, 128);
          return 136;
        }
        if (flavor === 9) {
          memory.write('/isolated/中文\0', 152, 'utf8');
          return 2352;
        }
        throw new Error('Unexpected fixture ABI call');
      },
      sysctl(_mib: Buffer, _count: number, memory: Buffer, size: number[]) {
        environment.copy(memory);
        size[0] = environment.length;
        environmentMemory = memory;
        return 0;
      },
    },
  });
  runInContext(source, context);
  const invoke = runInContext('run', context) as (args: string[]) => string;
  return {
    identity: () => JSON.parse(invoke(['identity', '1234'])),
    cleared: () => environmentMemory?.every((byte) => byte === 0),
  };
}
it('reads exact NUL-separated execution markers, ignores argv/other values, and outputs only approved metadata', () => {
  const h = fixture([
    'UNRELATED=CODEX_THREAD_ID=value-spoof',
    'PRIVATE=must-not-escape',
    'CODEX_THREAD_ID=thread-a',
    'CODEX_TOOL_CALL_ID=call-a',
  ]);
  expect(h.identity()).toEqual({
    pid: 1234,
    parent: 100,
    birth: '1700000000.123456',
    cwd: '/isolated/中文',
    thread: 'thread-a',
    call: 'call-a',
  });
  expect(h.cleared()).toBe(true);
});
it.each([
  ['UNRELATED=CODEX_THREAD_ID=thread-a CODEX_TOOL_CALL_ID=call-a'],
  ['CODEX_THREAD_ID=thread-a', 'CODEX_THREAD_ID=thread-a', 'CODEX_TOOL_CALL_ID=call-a'],
  ['CODEX_THREAD_ID=thread-a value', 'CODEX_TOOL_CALL_ID=call-a'],
])('rejects missing, duplicate or invalid real markers and clears raw memory', (...entries) => {
  const h = fixture(entries);
  expect(h.identity).toThrow('Process metadata is unavailable');
  expect(h.cleared()).toBe(true);
});
it('rejects truncated kernel data and a changed process birth identity', () => {
  const entries = ['CODEX_THREAD_ID=thread-a', 'CODEX_TOOL_CALL_ID=call-a'];
  const truncated = fixture(entries, { truncated: true });
  expect(truncated.identity).toThrow('Process metadata is unavailable');
  expect(truncated.cleared()).toBe(true);
  const reused = fixture(entries, { reused: true });
  expect(reused.identity).toThrow('Process metadata is unavailable');
  expect(reused.cleared()).toBe(true);
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const resources: { adapter: CodexAdapter; directory: string }[] = [];
afterEach(async () => {
  for (const { adapter, directory } of resources.splice(0)) {
    await adapter.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup(options: SimulatorOptions = {}, requestTimeoutMs = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-rename-adapter-'));
  const logPath = join(directory, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ turnDelayMs: 10, ...options, logPath }),
    ],
    requestTimeoutMs,
  });
  resources.push({ adapter, directory });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  const requests = async () =>
    (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: { threadId?: string; name?: string; ephemeral?: boolean };
          },
      );
  return { adapter, events, requests };
}

it('writes a native name and receives notifications without creating a user turn', async () => {
  const { adapter, events, requests } = await setup();
  const thread = await adapter.createThread('/tmp');
  await adapter.renameThread(thread.id, '  手工名称 🧪  ');
  expect(await adapter.readThread(thread.id)).toMatchObject({
    id: thread.id,
    title: '手工名称 🧪',
    turns: [],
  });
  expect(events).toContainEqual({ type: 'threadName', threadId: thread.id, name: '手工名称 🧪' });
  expect((await requests()).filter((entry) => entry.method === 'turn/start')).toEqual([]);
  await expect(adapter.renameThread(thread.id, 'bad\nname')).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  expect((await requests()).filter((entry) => entry.method === 'thread/name/set')).toHaveLength(1);
});

it('cancels pending title generation and never overwrites a manual name on later messages', async () => {
  const { adapter, requests } = await setup({ titleDelayMs: 2000 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, 'Start automatic naming');
  await vi.waitFor(async () =>
    expect(
      (await requests()).some((entry) => entry.method === 'thread/start' && entry.params.ephemeral),
    ).toBe(true),
  );
  await adapter.renameThread(thread.id, '用户明确名称');
  await vi.waitFor(async () =>
    expect(
      (await requests()).filter((entry) => entry.method === 'thread/unsubscribe'),
    ).toHaveLength(1),
  );
  // Cancelling the title task does not mean the original user turn has completed.
  await vi.waitFor(async () =>
    expect((await adapter.readThread(thread.id)).turns.at(-1)?.status).toBe('completed'),
  );
  await adapter.startTurn(thread.id, thread.cwd, 'Another message');
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('用户明确名称');
  expect(
    (await requests())
      .filter((entry) => entry.method === 'thread/name/set')
      .map((entry) => entry.params.name),
  ).toEqual(['用户明确名称']);
});

it('waits for an already dispatched automatic name write before writing the explicit name', async () => {
  const { adapter, requests } = await setup({ nameWriteDelayMs: 400 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, 'Trigger automatic title');
  await vi.waitFor(async () =>
    expect((await requests()).filter((entry) => entry.method === 'thread/name/set')).toHaveLength(
      1,
    ),
  );
  const renaming = adapter.renameThread(thread.id, '显式名称优先');
  await adapter.readThreadMetadata(thread.id);
  expect((await requests()).filter((entry) => entry.method === 'thread/name/set')).toHaveLength(1);
  await renaming;
  expect(
    (await requests())
      .filter((entry) => entry.method === 'thread/name/set')
      .map((entry) => entry.params.name),
  ).toEqual(['Codex 配置继承与运行设置', '显式名称优先']);
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('显式名称优先');
});

it('does not issue a manual write after an uncertain automatic write and reports unsupported methods', async () => {
  // Leave room for the fixture process to start; the 2s write still exceeds the RPC deadline.
  const { adapter, requests } = await setup({ nameWriteDelayMs: 2000 }, 1000);
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, 'Trigger a slow title write');
  await vi.waitFor(async () =>
    expect((await requests()).filter((entry) => entry.method === 'thread/name/set')).toHaveLength(
      1,
    ),
  );
  await vi.waitFor(
    async () =>
      expect(
        (await requests()).filter((entry) => entry.method === 'thread/unsubscribe'),
      ).toHaveLength(1),
    { timeout: 2500 },
  );
  await adapter.startTurn(thread.id, thread.cwd, 'Do not retry an uncertain automatic write');
  await vi.waitFor(async () =>
    expect((await adapter.readThread(thread.id)).turns.at(-1)?.status).toBe('completed'),
  );
  expect(
    (await requests()).filter((entry) => entry.method === 'thread/start' && entry.params.ephemeral),
  ).toHaveLength(1);
  await expect(adapter.renameThread(thread.id, 'Must wait')).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
    uncertain: true,
  });
  await expect(adapter.renameThread(thread.id, 'No automatic replay')).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  expect((await requests()).filter((entry) => entry.method === 'thread/name/set')).toHaveLength(1);
  const unsupported = await setup({ unsupportedMethod: 'thread/name/set' });
  const other = await unsupported.adapter.createThread('/tmp');
  await expect(unsupported.adapter.renameThread(other.id, 'Name')).rejects.toMatchObject({
    rpcCode: -32601,
  });
  expect(unsupported.adapter.diagnostics().capabilities).not.toContain('thread/name/set');
});

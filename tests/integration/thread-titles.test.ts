import { afterEach, expect, it, vi } from 'vitest';
import type { ServerMessage, ThreadPage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const result = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (result.result as { threadId: string }).threadId;
  const cached = ctx.service.projection.get(id)!;
  const actual = ctx.codex.threads.get(id)!;
  cached.title = actual.title = '新会话';
  return { ...ctx, id, cached, actual };
}

it('uses fresh list titles without replacing live messages, status, approvals or execution', async () => {
  const { service, codex, store, id, cached, actual } = await setup();
  await service.startTurn(id, { clientOperationId: operationId(), text: 'first question' });
  await vi.waitFor(() => expect(cached.title).toBe('新会话'));
  codex.emit({
    type: 'action',
    action: {
      actionId: 'approval',
      codexEpoch: codex.epoch,
      rpcId: 1,
      threadId: id,
      turnId: 'turn-1',
      kind: 'command',
      status: 'pending',
      title: '执行命令',
      options: [{ id: 'accept', label: '允许' }],
    },
  });
  actual.title = 'App Server 会话名称';
  actual.status = 'idle';
  const before = structuredClone(cached);
  const marker = store.activeForThread(id);
  const events: ServerMessage[] = [];
  service.subscribeOverview((event) => events.push(event));
  const list = await service.listThreads('project');
  expect(list.data[0]).toMatchObject({ ...before, title: actual.title });
  expect(cached).toEqual({ ...before, title: actual.title });
  expect(store.activeForThread(id)).toEqual(marker);
  expect(events.at(-1)).toMatchObject({ kind: 'threadSummary', payload: { title: actual.title } });
});

it('refreshes cached detail titles with metadata only and keeps offline content readable', async () => {
  const { service, codex, id, cached, actual } = await setup();
  actual.title = '最新预览';
  const history = vi.spyOn(codex, 'readThread');
  const metadata = vi.spyOn(codex, 'readThreadMetadata');
  expect(await service.getThread(id)).toMatchObject({ title: actual.title });
  expect(metadata).toHaveBeenCalledWith(id);
  expect(history).not.toHaveBeenCalled();
  metadata.mockRejectedValue(new Error('unavailable'));
  expect(await service.getThread(id)).toMatchObject({ title: cached.title });
});

it('reads the upstream preview at turn boundaries, without deriving a title from messages', async () => {
  const { service, codex, id, cached, actual } = await setup();
  actual.title = '上游提供的预览';
  await service.startTurn(id, { clientOperationId: operationId(), text: '不同的用户消息' });
  await vi.waitFor(() => expect(cached.title).toBe('上游提供的预览'));
  actual.title = '上游最终名称';
  codex.complete(id, 'turn-1');
  await vi.waitFor(() => expect(cached.title).toBe('上游最终名称'));
});

it('publishes name notifications to detail and overview, and reads the fallback when cleared', async () => {
  const { service, codex, id, cached, actual } = await setup();
  const detail: ServerMessage[] = [];
  const overview: ServerMessage[] = [];
  await service.subscribe(id, undefined, (event) => detail.push(event));
  service.subscribeOverview((event) => overview.push(event));
  // A deliberately chosen name that looks like the placeholder is still an explicit name.
  for (const name of ['自定义名称', '新会话']) {
    actual.title = name;
    codex.emit({ type: 'threadName', threadId: id, name });
    expect(cached.title).toBe(name);
    expect(detail.at(-1)).toMatchObject({
      kind: 'threadPatch',
      payload: { thread: { title: name } },
    });
    expect(overview.at(-1)).toMatchObject({ kind: 'threadSummary', payload: { title: name } });
  }
  actual.title = '上游回退预览';
  codex.emit({ type: 'threadName', threadId: id });
  await vi.waitFor(() => expect(cached.title).toBe(actual.title));
});

it.each(['list', 'detail'] as const)(
  'does not let a delayed %s response overwrite a name notification',
  async (source) => {
    const { service, codex, id, cached, actual } = await setup();
    const snapshot = structuredClone(actual);
    const list = deferred<ThreadPage>();
    const detail = deferred<ThreadView>();
    const entered = deferred<void>();
    vi.spyOn(codex, 'listThreads').mockImplementation(() => {
      entered.resolve();
      return list.promise;
    });
    vi.spyOn(codex, 'readThreadMetadata').mockImplementation(() => {
      entered.resolve();
      return detail.promise;
    });
    const pending = source === 'list' ? service.listThreads('project') : service.getThread(id);
    await entered.promise;
    actual.title = '较新的名称';
    codex.emit({ type: 'threadName', threadId: id, name: actual.title });
    list.resolve({ data: [snapshot], nextCursor: null });
    detail.resolve(snapshot);
    await pending;
    expect(cached.title).toBe(actual.title);
  },
);

it('keeps the latest list request authoritative when responses arrive out of order', async () => {
  const { service, codex, cached, actual } = await setup();
  const old = deferred<ThreadPage>();
  const snapshot = structuredClone(actual);
  vi.spyOn(codex, 'listThreads').mockImplementationOnce(() => old.promise);
  const pending = service.listThreads('project');
  actual.title = '最新列表名称';
  await service.listThreads('project');
  old.resolve({ data: [snapshot], nextCursor: null });
  await pending;
  expect(cached.title).toBe(actual.title);
});

it('ignores metadata from an old runtime and preserves a live name across late thread receipts', async () => {
  const { service, codex, id, cached, actual } = await setup();
  const snapshot = structuredClone(actual);
  const gate = deferred<ThreadView>();
  const entered = deferred<void>();
  vi.spyOn(codex, 'readThreadMetadata').mockImplementationOnce(() => {
    entered.resolve();
    return gate.promise;
  });
  const pending = service.getThread(id);
  await entered.promise;
  codex.reset();
  codex.emit({ type: 'threadName', threadId: id, name: '当前运行时名称' });
  codex.emit({ type: 'thread', thread: snapshot });
  gate.resolve(snapshot);
  await pending;
  expect(cached.title).toBe('当前运行时名称');
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const context of resources.splice(0)) {
    await context.service.shutdown();
    context.close();
  }
});

async function setup() {
  const context = harness();
  resources.push(context);
  const create = async () => {
    const result = await context.service.createThread('project', {
      clientOperationId: operationId(),
    });
    return (result.result as { threadId: string }).threadId;
  };
  const threadId = await create();
  await context.service.startTurn(threadId, {
    clientOperationId: operationId(),
    text: '继续工作',
  });
  const turnId = context.codex.threads.get(threadId)!.turns[0]!.id;
  const error = (message = 'Reconnecting… 1/5', willRetry = true) =>
    context.codex.emit({ type: 'turnError', threadId, turnId, message, willRetry });
  const progress = () => context.codex.emit({ type: 'turnProgress', threadId, turnId });
  const read = () => context.service.getThread(threadId);
  return { ...context, create, threadId, turnId, error, progress, read };
}

describe('Codex upstream reconnection state', () => {
  it('keeps retries through history reads and new subscriptions without changing busy controls', async () => {
    const ctx = await setup();
    const marker = ctx.store.activeForThread(ctx.threadId);
    ctx.error();
    ctx.error('Reconnecting… 2/5');
    const retry = { status: 'retrying', message: 'Reconnecting… 2/5' };
    expect(await ctx.read()).toMatchObject({
      status: 'running',
      turns: [{ status: 'running', reconnect: retry }],
    });
    expect(ctx.store.activeForThread(ctx.threadId)).toEqual(marker);
    const messages: ServerMessage[] = [];
    const unsubscribe = await ctx.service.subscribe(ctx.threadId, undefined, (message) =>
      messages.push(message),
    );
    expect(messages[0]).toMatchObject({
      type: 'snapshot',
      data: { turns: [{ reconnect: retry }] },
    });
    await expect(
      ctx.service.startTurn(ctx.threadId, { clientOperationId: operationId(), text: '重复任务' }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(ctx.codex.starts).toBe(1);
    expect(ctx.service.getSystem().connection).toBe('ready');
    unsubscribe();
  });

  it('clears only the matching retry on live model progress, then continues streaming', async () => {
    const ctx = await setup();
    const other = await ctx.create();
    await ctx.service.startTurn(other, { clientOperationId: operationId(), text: '并行任务' });
    ctx.error();
    ctx.codex.emit({ type: 'turnProgress', threadId: other, turnId: 'turn-2' });
    ctx.codex.emit({ type: 'turnProgress', threadId: ctx.threadId, turnId: 'different-turn' });
    ctx.codex.emit({
      type: 'delta',
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: 'tool',
      field: 'output',
      delta: 'still running',
      itemType: 'commandExecution',
    });
    ctx.codex.emit({ type: 'threadStatus', threadId: ctx.threadId, status: 'running' });
    expect((await ctx.read()).turns[0]!.reconnect?.status).toBe('retrying');
    expect((await ctx.service.getThread(other)).turns[0]!.reconnect).toBeUndefined();

    const messages: ServerMessage[] = [];
    const unsubscribe = await ctx.service.subscribe(ctx.threadId, undefined, (message) =>
      messages.push(message),
    );
    ctx.progress();
    ctx.codex.emit({
      type: 'delta',
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: 'reply',
      field: 'text',
      delta: '恢复后继续回答',
      itemType: 'agentMessage',
    });
    const recovered = await ctx.read();
    expect(recovered.turns[0]!.reconnect).toBeUndefined();
    expect(recovered.turns[0]!.items).toContainEqual(
      expect.objectContaining({ text: '恢复后继续回答' }),
    );
    const latest = messages
      .filter((message) => message.type === 'event' && message.kind === 'threadPatch')
      .at(-1);
    expect(latest).toMatchObject({ payload: { turns: [{ turn: { status: 'running' } }] } });
    expect(JSON.stringify(latest)).not.toContain('reconnect');
    ctx.error('Reconnecting… 1/5');
    expect((await ctx.read()).turns[0]!.reconnect?.status).toBe('retrying');
    unsubscribe();
  });

  it('shows stopped retries immediately but retains execution ownership until turn completion', async () => {
    const ctx = await setup();
    ctx.error();
    ctx.error('stream disconnected; retry limit reached', false);
    ctx.progress();
    expect((await ctx.read()).turns[0]).toMatchObject({
      status: 'running',
      reconnect: { status: 'failed', message: 'stream disconnected; retry limit reached' },
    });
    expect(ctx.store.activeForThread(ctx.threadId)).toBeDefined();
    const turn = ctx.codex.threads.get(ctx.threadId)!.turns[0]!;
    turn.status = 'failed';
    turn.error = 'stream disconnected; retry limit reached';
    ctx.codex.emit({ type: 'turn', threadId: ctx.threadId, turn: structuredClone(turn) });
    expect((await ctx.read()).turns[0]).toMatchObject({
      status: 'failed',
      reconnect: { status: 'failed', message: turn.error },
    });
    expect(ctx.store.activeForThread(ctx.threadId)).toBeUndefined();
    await ctx.service.startTurn(ctx.threadId, { clientOperationId: operationId(), text: '继续' });
    expect((await ctx.read()).turns[1]!.reconnect).toBeUndefined();
  });

  it.each(['completed', 'interrupted', 'failed'] as const)(
    'ends the retry display on %s even when the terminal error notification was missed',
    async (status) => {
      const ctx = await setup();
      ctx.error();
      const turn = ctx.codex.threads.get(ctx.threadId)!.turns[0]!;
      turn.status = status;
      ctx.codex.threads.get(ctx.threadId)!.status = 'idle';
      if (status === 'failed') turn.error = 'connection closed';
      // History can recover a missed terminal notification.
      const thread = await ctx.read();
      expect(thread.turns[0]!.reconnect).toEqual(
        status === 'failed' ? { status: 'failed', message: 'connection closed' } : undefined,
      );
      ctx.error('late retry');
      expect((await ctx.read()).turns[0]!.reconnect?.status).not.toBe('retrying');
    },
  );

  it('does not infer retries from silence, normal events, ordinary errors, or unrelated threads', async () => {
    const ctx = await setup();
    ctx.progress();
    ctx.codex.emit({
      type: 'turnError',
      threadId: 'unregistered',
      turnId: ctx.turnId,
      message: 'Reconnecting…',
      willRetry: true,
    });
    ctx.error('Context window exceeded', false);
    const thread = await ctx.read();
    expect(thread.turns[0]!.reconnect).toBeUndefined();
    expect(ctx.service.projection.get('unregistered')).toBeUndefined();
  });

  it('preserves a new retry over an older terminal history read and clears it on runtime reset', async () => {
    const ctx = await setup();
    const stale = structuredClone(ctx.codex.threads.get(ctx.threadId)!);
    stale.turns[0]!.status = 'completed';
    const gate = deferred<ThreadView>();
    const entered = deferred<void>();
    vi.spyOn(ctx.codex, 'readThread').mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const pending = ctx.read();
    await entered.promise;
    ctx.error();
    gate.resolve(stale);
    expect((await pending).turns[0]).toMatchObject({
      status: 'running',
      reconnect: { status: 'retrying' },
    });
    ctx.codex.ready = false;
    ctx.codex.emit({ type: 'runtime', diagnostics: ctx.codex.diagnostics() });
    expect((await ctx.read()).turns[0]).toMatchObject({ status: 'unknown' });
    expect((await ctx.read()).turns[0]!.reconnect).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexError } from '../../src/codex/transport.js';
import { MODEL_CAPACITY_MESSAGE } from '../../src/shared/turn-errors.js';
import type { Settings, TurnView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const ctx of resources.splice(0)) {
    await ctx.service.shutdown();
    ctx.close();
  }
  vi.useRealTimers();
});

async function setup(
  settings: Settings = {
    model: 'original-model',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    permissionMode: 'read-only',
  },
) {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const starts = vi.spyOn(ctx.codex, 'startTurn');
  const operation = await ctx.service.startTurn(id, {
    clientOperationId: operationId(),
    text: 'original prompt',
    images: ['original-image'],
    settings,
  });
  const turn = () => ctx.codex.threads.get(id)!.turns.at(-1)!;
  const fail = (
    message = MODEL_CAPACITY_MESSAGE,
    errorCode: string | null = 'serverOverloaded',
  ) => {
    const current = turn();
    ctx.codex.emit({
      type: 'turnError',
      threadId: id,
      turnId: current.id,
      message,
      errorCode: errorCode ?? undefined,
      willRetry: false,
    });
    current.error = message;
    current.errorCode = errorCode ?? undefined;
    current.status = 'failed';
    ctx.codex.threads.get(id)!.status = 'failed';
    ctx.codex.emit({ type: 'turn', threadId: id, turn: structuredClone(current) });
  };
  const read = () => ctx.service.getThread(id);
  return { ...ctx, id, turn, fail, read, starts, settings, operation };
}

describe('bounded capacity recovery', () => {
  it('waits on the server, survives reads, and continues with empty input and the original settings', async () => {
    const ctx = await setup();
    ctx.fail();
    const waiting = (await ctx.read()).capacityRetry!;
    expect(waiting).toMatchObject({
      status: 'waiting',
      attempt: 1,
      limit: 3,
      nextAttemptAt: Date.now() + 5000,
    });
    expect((await ctx.read()).capacityRetry).toEqual(waiting);
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    ctx.settings.model = 'changed-after-send';
    await vi.advanceTimersByTimeAsync(4999);
    expect(ctx.starts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    expect(ctx.starts.mock.calls[1]).toEqual([
      ctx.id,
      ctx.starts.mock.calls[0]![1],
      '',
      { ...ctx.settings, model: 'original-model' },
      undefined,
    ]);
    expect(ctx.store.activeForThread(ctx.id)?.turnId).toBe(ctx.turn().id);
    expect((await ctx.read()).turns.at(-1)?.retryOf).toBe(waiting.rootTurnId);
    expect(ctx.store.capacityRetryTurns(ctx.id).get(ctx.turn().id)).toBe(waiting.rootTurnId);
    ctx.codex.complete(ctx.id, ctx.turn().id);
    expect((await ctx.read()).capacityRetry).toBeUndefined();
    expect((await ctx.read()).status).toBe('completed');
  });

  it('uses 5, 10 and 20 second delays and never starts a fourth retry', async () => {
    const ctx = await setup();
    for (const [index, delay] of [5000, 10000, 20000].entries()) {
      ctx.fail();
      expect((await ctx.read()).capacityRetry).toMatchObject({
        status: 'waiting',
        attempt: index + 1,
        nextAttemptAt: Date.now() + delay,
      });
      await vi.advanceTimersByTimeAsync(delay);
    }
    ctx.fail();
    expect((await ctx.read()).capacityRetry).toMatchObject({
      status: 'stopped',
      reason: 'limit',
      attempt: 3,
    });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(4);
  });

  it('deduplicates errors and terminal notifications, including late events from old turns', async () => {
    const ctx = await setup();
    const original = ctx.turn();
    ctx.fail();
    ctx.fail();
    await vi.advanceTimersByTimeAsync(5000);
    ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: structuredClone(original) });
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    ctx.fail();
    await vi.advanceTimersByTimeAsync(10000);
    expect(ctx.starts).toHaveBeenCalledTimes(3);
  });

  it.each(['agentMessage', 'commandExecution', 'fileChange', 'reasoning'])(
    'does not replay after %s progress',
    async (type) => {
      const ctx = await setup();
      const item = { id: 'already-produced', type, text: 'already done', status: 'completed' };
      ctx.turn().items.push(item);
      ctx.codex.emit({ type: 'item', threadId: ctx.id, turnId: ctx.turn().id, item });
      ctx.fail();
      expect((await ctx.read()).capacityRetry).toMatchObject({
        status: 'stopped',
        reason: 'progress',
      });
      await vi.advanceTimersByTimeAsync(120000);
      expect(ctx.starts).toHaveBeenCalledTimes(1);
    },
  );

  it('never adds its retry budget after native retries', async () => {
    const ctx = await setup();
    ctx.codex.emit({
      type: 'turnError',
      threadId: ctx.id,
      turnId: ctx.turn().id,
      message: 'Reconnecting... 2/5',
      willRetry: true,
    });
    ctx.fail();
    expect((await ctx.read()).capacityRetry).toMatchObject({ status: 'stopped', reason: 'native' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(1);
  });

  it('does not treat quoted text or conflicting structured errors as capacity failures', async () => {
    const ctx = await setup();
    ctx.codex.emit({
      type: 'delta',
      threadId: ctx.id,
      turnId: ctx.turn().id,
      itemId: 'quote',
      field: 'text',
      delta: MODEL_CAPACITY_MESSAGE,
      itemType: 'agentMessage',
    });
    expect((await ctx.read()).capacityRetry).toBeUndefined();
    ctx.fail(MODEL_CAPACITY_MESSAGE, 'badRequest');
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(1);
    expect((await ctx.read()).capacityRetry).toBeUndefined();
  });

  it('recognizes the exact legacy error only in an actual failure', async () => {
    const ctx = await setup();
    ctx.fail(MODEL_CAPACITY_MESSAGE, null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled retry and accepts a user replacement without a race', async () => {
    const ctx = await setup();
    ctx.fail();
    await ctx.service.cancelCapacityRetry(ctx.id, {
      clientOperationId: operationId(),
      expectedTurnId: ctx.turn().id,
    });
    expect((await ctx.read()).capacityRetry?.status).toBe('cancelled');
    await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'replacement' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    expect(ctx.starts.mock.calls[1]?.[2]).toBe('replacement');
    expect((await ctx.read()).capacityRetry).toBeUndefined();
  });

  it('a new user request supersedes a pending timer without requiring cancellation first', async () => {
    const ctx = await setup();
    ctx.fail();
    await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'new task' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    await expect(
      ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'concurrent' }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  });

  it('interrupts a retry cancelled before its delayed receipt and does not retry again', async () => {
    const ctx = await setup();
    ctx.fail();
    const root = ctx.turn().id;
    ctx.codex.startGate = deferred<TurnView>();
    await vi.advanceTimersByTimeAsync(5000);
    const current = structuredClone(ctx.turn());
    expect(current.id).not.toBe(root);
    await ctx.service.cancelCapacityRetry(ctx.id, {
      clientOperationId: operationId(),
      expectedTurnId: root,
    });
    expect(ctx.codex.interrupts).toBe(1);
    ctx.codex.startGate.resolve(current);
    await vi.advanceTimersByTimeAsync(0);
    ctx.fail();
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.codex.interrupts).toBe(1);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
  });

  it('never repeats a continuation whose dispatch result is uncertain', async () => {
    const ctx = await setup();
    ctx.fail();
    ctx.starts.mockRejectedValueOnce(new CodexError('CODEX_UNAVAILABLE', 'receipt lost', true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.store.activeForThread(ctx.id)?.state).toBe('unknown');
    expect((await ctx.read()).capacityRetry).toMatchObject({ status: 'stopped', reason: 'error' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
  });

  it('requires an acknowledged original dispatch before automatic continuation', async () => {
    const ctx = await setup();
    // An original request can fail before its receipt arrives. Do not race the receipt.
    const gate = deferred<TurnView>();
    ctx.codex.startGate = gate;
    ctx.codex.complete(ctx.id, ctx.turn().id);
    const pending = ctx.service.startTurn(ctx.id, {
      clientOperationId: operationId(),
      text: 'delayed receipt',
    });
    await vi.advanceTimersByTimeAsync(0);
    ctx.fail();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    gate.resolve(structuredClone(ctx.turn()));
    await pending;
    expect((await ctx.read()).capacityRetry).toMatchObject({ status: 'stopped', reason: 'error' });
  });

  it('drops timers on runtime changes', async () => {
    const ctx = await setup();
    ctx.fail();
    ctx.codex.reset();
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(1);
    expect((await ctx.read()).capacityRetry).toBeUndefined();
  });

  it('stops on late progress and on a different error while the timer is waiting', async () => {
    const first = await setup();
    first.fail();
    first.codex.emit({ type: 'turnProgress', threadId: first.id, turnId: first.turn().id });
    expect((await first.read()).capacityRetry?.reason).toBe('progress');
    const second = await setup();
    second.fail();
    second.codex.emit({
      type: 'turnError',
      threadId: second.id,
      turnId: second.turn().id,
      message: 'unauthorized',
      errorCode: 'unauthorized',
      willRetry: false,
    });
    expect((await second.read()).capacityRetry?.reason).toBe('error');
    await vi.advanceTimersByTimeAsync(120000);
    expect(first.starts).toHaveBeenCalledTimes(1);
    expect(second.starts).toHaveBeenCalledTimes(1);
  });

  it('cancels before an unannounced continuation receipt and interrupts only its eventual native ID', async () => {
    const ctx = await setup();
    ctx.fail();
    const root = ctx.turn().id;
    const gate = deferred<TurnView>();
    ctx.starts.mockImplementationOnce(async () => gate.promise);
    await vi.advanceTimersByTimeAsync(5000);
    await ctx.service.cancelCapacityRetry(ctx.id, {
      clientOperationId: operationId(),
      expectedTurnId: root,
    });
    expect(ctx.codex.interrupts).toBe(0);
    const current: TurnView = {
      id: 'unannounced-retry',
      threadId: ctx.id,
      status: 'running',
      items: [],
    };
    ctx.codex.threads.get(ctx.id)!.turns.push(current);
    gate.resolve(current);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.codex.interrupts).toBe(1);
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
  });

  it('stops waiting retries when the thread is archived or the gateway shuts down', async () => {
    const ctx = await setup();
    ctx.fail();
    await ctx.service.setThreadArchived(ctx.id, {
      clientOperationId: operationId(),
      archived: true,
    });
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(1);
    const other = await setup();
    other.fail();
    await other.service.shutdown();
    await vi.advanceTimersByTimeAsync(120000);
    expect(other.starts).toHaveBeenCalledTimes(1);
  });

  it('replaying an old lifecycle receipt does not cancel a newer capacity retry', async () => {
    const ctx = await setup();
    ctx.codex.complete(ctx.id, ctx.turn().id);
    const oldResume = { clientOperationId: operationId() };
    await ctx.service.resumeThread(ctx.id, oldResume);
    await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'new task' });
    ctx.fail();
    const before = (await ctx.read()).capacityRetry;
    await ctx.service.resumeThread(ctx.id, oldResume);
    expect((await ctx.read()).capacityRetry).toEqual(before);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.starts).toHaveBeenCalledTimes(3);
  });

  it('supports an explicit manual retry with a changed model and an idempotent operation receipt', async () => {
    const ctx = await setup();
    ctx.fail();
    const request = {
      clientOperationId: operationId(),
      expectedTurnId: ctx.turn().id,
      settings: { model: 'user-selected-model' },
    };
    await ctx.service.retryTurn(ctx.id, request);
    await ctx.service.retryTurn(ctx.id, request);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
    expect(ctx.starts.mock.calls[1]?.slice(2)).toEqual(['', request.settings, undefined]);
    await vi.advanceTimersByTimeAsync(120000);
    expect(ctx.starts).toHaveBeenCalledTimes(2);
  });
});

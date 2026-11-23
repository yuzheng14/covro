import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingAction } from '../../src/shared/types.js';
import { GatewayService } from '../../src/server/service.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
const setup = () => {
  const value = harness();
  resources.push(value);
  return value;
};
afterEach(() => {
  for (const value of resources.splice(0)) value.close();
});
async function create(ctx: ReturnType<typeof harness>) {
  const operation = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return (operation.result as { threadId: string }).threadId;
}

describe('domain execution and approval recovery', () => {
  it('dispatches concurrent retries once, returns the durable receipt, and keeps the turn running after ack', async () => {
    const ctx = setup();
    const id = await create(ctx);
    ctx.codex.startGate = deferred();
    const input = { clientOperationId: operationId(), text: '做一个测试' };
    const first = ctx.service.startTurn(id, input);
    const retry = await ctx.service.startTurn(id, input);
    expect(['accepted', 'dispatching']).toContain(retry.status);
    await Promise.resolve();
    expect(ctx.codex.starts).toBe(1);
    ctx.codex.startGate.resolve(ctx.codex.threads.get(id)!.turns[0]!);
    expect((await first).status).toBe('acknowledged');
    expect((await ctx.service.getThread(id)).status).toBe('running');
    expect(ctx.store.activeForThread(id)).toBeDefined();
    await expect(ctx.service.startTurn(id, { ...input, text: '不同内容' })).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    });
    expect(ctx.codex.starts).toBe(1);
    ctx.codex.complete(id, 'turn-1');
    expect(ctx.store.activeForThread(id)).toBeUndefined();
  });

  it('waits for tracked requests and running turns before closing restart admission', async () => {
    const ctx = setup();
    const id = await create(ctx);
    const mutating = deferred<void>();
    const request = ctx.service.trackHttpMutation(() => mutating.promise);
    expect(ctx.service.restartBlockers(true)).toEqual(['operation']);
    mutating.resolve();
    await request;

    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'running' });
    expect(ctx.service.restartBlockers(true)).toEqual(['running']);
    ctx.codex.complete(id, 'turn-1');
    expect(ctx.service.restartBlockers(true)).toEqual([]);
    expect(ctx.service.prepareUpdate('backup').ready).toBe(false);
    ctx.service.setMaintenance(false, 'update');
    await expect(
      ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'too late' }),
    ).rejects.toMatchObject({ code: 'RESTART_MAINTENANCE' });
    ctx.service.setMaintenance(false, 'restart');
    expect(ctx.service.isInMaintenance()).toBe(false);
  });

  it('handles a terminal event arriving before the start response without resurrecting the turn', async () => {
    const ctx = setup();
    const id = await create(ctx);
    ctx.codex.onStart = (threadId, turn) => {
      ctx.codex.complete(threadId, turn.id);
    };
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'test' });
    expect((await ctx.service.getThread(id)).status).toBe('completed');
    expect(ctx.store.activeForThread(id)).toBeUndefined();
  });

  it('allows parallel threads and releases only the interrupted turn after terminal evidence', async () => {
    const ctx = setup();
    const first = await create(ctx);
    const second = await create(ctx);
    await ctx.service.startTurn(first, { clientOperationId: operationId(), text: 'one' });
    await expect(
      ctx.service.startTurn(second, { clientOperationId: operationId(), text: 'two' }),
    ).resolves.toMatchObject({ status: 'acknowledged' });
    expect(ctx.store.activeMarkers()).toHaveLength(2);
    const secondMarker = ctx.store.activeForThread(second);
    await expect(
      ctx.service.startTurn(first, { clientOperationId: operationId(), text: 'duplicate turn' }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await expect(
      ctx.service.steer(first, {
        clientOperationId: operationId(),
        expectedTurnId: 'obsolete',
        text: 'append',
      }),
    ).rejects.toMatchObject({ code: 'TURN_CONFLICT' });
    await ctx.service.steer(first, {
      clientOperationId: operationId(),
      expectedTurnId: 'turn-1',
      text: 'append',
    });
    await ctx.service.interrupt(first, {
      clientOperationId: operationId(),
      expectedTurnId: 'turn-1',
    });
    expect(ctx.store.activeForThread(first)).toBeDefined();
    ctx.codex.complete(first, 'turn-1');
    expect(ctx.store.activeForThread(first)).toBeUndefined();
    expect(ctx.store.activeForThread(second)).toEqual(secondMarker);
    await ctx.service.startTurn(first, { clientOperationId: operationId(), text: 'next turn' });
    expect(ctx.codex.starts).toBe(3);
  });

  it('lets only one tab claim an approval and rejects stale actions after runtime reset', async () => {
    const ctx = setup();
    const id = await create(ctx);
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'test' });
    const action: PendingAction = {
      actionId: 'a',
      codexEpoch: ctx.codex.epoch,
      rpcId: 0,
      kind: 'command',
      threadId: id,
      turnId: 'turn-1',
      status: 'pending',
      title: '运行命令',
      options: [
        { id: 'accept', label: '允许' },
        { id: 'decline', label: '拒绝' },
      ],
    };
    ctx.codex.emit({ type: 'action', action });
    ctx.codex.replyGate = deferred();
    expect((await ctx.service.getThread(id)).status).toBe('waitingApproval');
    const answer = ctx.service.resolveAction('a', {
      clientOperationId: operationId(),
      resolution: { decision: 'accept' },
    });
    await expect(
      ctx.service.resolveAction('a', {
        clientOperationId: operationId(),
        resolution: { decision: 'decline' },
      }),
    ).rejects.toMatchObject({ code: 'ACTION_CONFLICT' });
    expect(ctx.codex.replies).toBe(1);
    ctx.codex.replyGate.resolve();
    await answer;
    expect((await ctx.service.getThread(id)).actions[0]?.status).toBe('responding');
    ctx.codex.emit({ type: 'actionResolved', actionId: 'a' });
    expect((await ctx.service.getThread(id)).actions[0]?.status).toBe('responded');
    ctx.codex.emit({ type: 'action', action: { ...action, actionId: 'old', status: 'pending' } });
    ctx.codex.reset();
    await expect(
      ctx.service.resolveAction('old', {
        clientOperationId: operationId(),
        resolution: { decision: 'accept' },
      }),
    ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  });

  it('validates every structured question and does not answer on browser unsubscribe', async () => {
    const ctx = setup();
    const id = await create(ctx);
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'test' });
    ctx.codex.emit({
      type: 'action',
      action: {
        actionId: 'questions',
        codexEpoch: ctx.codex.epoch,
        rpcId: '0',
        kind: 'questions',
        threadId: id,
        turnId: 'turn-1',
        status: 'pending',
        title: '选择',
        options: [],
        questions: [
          {
            id: 'one',
            header: '选项',
            question: '选哪个',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'A' }],
          },
          {
            id: 'two',
            header: '说明',
            question: '说明',
            isOther: true,
            isSecret: false,
            options: [],
          },
        ],
      },
    });
    const unsubscribe = await ctx.service.subscribe(id, undefined, () => {});
    unsubscribe();
    expect(ctx.codex.replies).toBe(0);
    expect(ctx.codex.stops).toBe(0);
    await expect(
      ctx.service.resolveAction('questions', {
        clientOperationId: operationId(),
        resolution: { answers: { one: ['B'], two: ['说明'] } },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await ctx.service.resolveAction('questions', {
      clientOperationId: operationId(),
      resolution: { answers: { one: ['A'], two: ['说明'] } },
    });
    expect(ctx.codex.replies).toBe(1);
  });

  it('acquires an external session without confirmation, but never resumes just to read or subscribe', async () => {
    const ctx = setup();
    const external = threadView('external', ctx.project);
    external.source = 'cli';
    ctx.codex.threads.set(external.id, external);
    await ctx.service.getThread(external.id);
    const unsubscribe = await ctx.service.subscribe(external.id, undefined, () => {});
    unsubscribe();
    expect(ctx.codex.resumes).toBe(0);
    await ctx.service.resumeThread(external.id, { clientOperationId: operationId() });
    await ctx.service.resumeThread(external.id, { clientOperationId: operationId() });
    expect(ctx.codex.resumes).toBe(1);
  });

  it('retains uncertain sends and rejects human reconciliation while upstream explicitly reports the old turn active', async () => {
    const ctx = setup();
    const id = await create(ctx);
    const operation = operationId();
    ctx.codex.startGate = deferred();
    const pending = ctx.service.startTurn(id, { clientOperationId: operation, text: 'test' });
    await Promise.resolve();
    ctx.codex.startGate.reject(Object.assign(new Error('timeout'), { uncertain: true }));
    await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(ctx.store.activeForThread(id)).toMatchObject({ state: 'unknown' });
    ctx.codex.reset();
    expect((await ctx.service.getThread(id)).status).toBe('unknown');
    await expect(
      ctx.service.reconcileOperation(operation, {
        clientOperationId: operationId(),
        confirmEnded: true,
      }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(ctx.store.activeForThread(id)).toBeDefined();
    expect(ctx.codex.starts).toBe(1);
    ctx.codex.threads.get(id)!.turns[0]!.status = 'completed';
    ctx.codex.threads.get(id)!.status = 'completed';
    await ctx.service.reconcileOperation(operation, {
      clientOperationId: operationId(),
      confirmEnded: true,
    });
    expect(ctx.service.getOperation(operation)).toMatchObject({
      status: 'unknown',
      execution: { ended: true },
      reconciliation: { decision: 'confirmed-ended' },
    });
  });

  it('recovers acknowledged unfinished execution as occupied in a new gateway', async () => {
    const ctx = setup();
    const id = await create(ctx);
    const operation = operationId();
    await ctx.service.startTurn(id, { clientOperationId: operation, text: 'test' });
    ctx.codex.epoch = 'new-epoch';
    const restarted = new GatewayService({
      store: ctx.store,
      projects: ctx.projects,
      codex: ctx.codex,
    });
    expect(restarted.getOperation(operation).status).toBe('acknowledged');
    expect((await restarted.getThread(id)).status).toBe('unknown');
    expect(ctx.store.activeForThread(id)?.state).toBe('unknown');
    await expect(
      restarted.resumeThread(id, {
        clientOperationId: operationId(),
        confirmExternalStopped: true,
      }),
    ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  });

  it('does not release an execution when a pending RPC rejects after runtime recovery', async () => {
    const ctx = setup();
    const id = await create(ctx);
    const operation = operationId();
    ctx.codex.startGate = deferred();
    const pending = ctx.service.startTurn(id, { clientOperationId: operation, text: 'test' });
    await Promise.resolve();
    ctx.codex.reset();
    ctx.codex.startGate.reject(Object.assign(new Error('child exited'), { uncertain: true }));
    await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(ctx.service.getOperation(operation)).toMatchObject({
      status: 'unknown',
      execution: { ended: false },
    });
    expect(ctx.store.activeForThread(id)?.state).toBe('unknown');
  });

  it('rechecks the current approval object when expiry replaces it during async validation', async () => {
    const ctx = setup();
    const id = await create(ctx);
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'test' });
    const action: PendingAction = {
      actionId: 'race',
      codexEpoch: ctx.codex.epoch,
      rpcId: 0,
      kind: 'command',
      threadId: id,
      turnId: 'turn-1',
      status: 'pending',
      title: '运行',
      options: [{ id: 'accept', label: '允许' }],
    };
    ctx.codex.emit({ type: 'action', action });
    const snapshot = await ctx.service.getThread(id);
    const spy = vi.spyOn(ctx.codex, 'readThread').mockImplementation(async () => {
      ctx.codex.emit({ type: 'action', action: { ...action, status: 'expired' } });
      return snapshot;
    });
    await expect(
      ctx.service.resolveAction('race', {
        clientOperationId: operationId(),
        resolution: { decision: 'accept' },
      }),
    ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(ctx.codex.replies).toBe(0);
    spy.mockRestore();
  });

  it('exposes an unfinished execution to a fresh browser and refreshes unknown history using real terminal evidence', async () => {
    const ctx = setup();
    const id = await create(ctx);
    const operation = operationId();
    await ctx.service.startTurn(id, { clientOperationId: operation, text: 'test' });
    ctx.codex.reset();
    expect(await ctx.service.getThread(id)).toMatchObject({
      status: 'unknown',
      execution: { operationId: operation, ended: false },
    });
    ctx.codex.threads.get(id)!.turns[0]!.status = 'completed';
    ctx.codex.threads.get(id)!.status = 'completed';
    const confirmed = await ctx.service.getThread(id);
    expect(confirmed.status).toBe('completed');
    expect(confirmed.execution).toBeUndefined();
    expect(ctx.service.getOperation(operation).status).toBe('acknowledged');
    expect(ctx.codex.starts).toBe(1);
  });
});

it('keeps managed sessions discoverable before the upstream history index includes them', async () => {
  const ctx = setup();
  const id = await create(ctx);
  vi.spyOn(ctx.codex, 'listThreads').mockResolvedValue({ data: [], nextCursor: 'later-page' });
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'live task' });
  const active = await ctx.service.listThreads('project');
  expect(active.data.map((thread) => thread.id)).toEqual([id]);
  expect(active.data[0]?.execution?.ended).toBe(false);
  expect(active.nextCursor).toBe('later-page');
  ctx.codex.complete(id, 'turn-1');
  expect((await ctx.service.listThreads('project')).data[0]?.turns[0]?.status).toBe('completed');
  expect((await ctx.service.listThreads('project', 'later-page')).data).toEqual([]);
});

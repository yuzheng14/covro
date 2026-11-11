import { afterEach, expect, it, vi } from 'vitest';
import type { RunStatus, ThreadView } from '../../src/shared/types.js';
import { GatewayService } from '../../src/server/service.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const create = async () => {
    const result = await ctx.service.createThread('project', { clientOperationId: operationId() });
    return (result.result as { threadId: string }).threadId;
  };
  const owner = await create();
  const target = await create();
  const send = (id: string) =>
    ctx.service.startTurn(id, {
      clientOperationId: operationId(),
      text: '继续任务',
      settings: {},
    });
  const original = await send(owner);
  const actual = ctx.codex.threads.get(owner)!;
  actual.title = '之前的工作';
  const finishSilently = (status: RunStatus = 'completed') => {
    actual.turns[0]!.status = status;
    actual.status = 'idle';
  };
  return { ...ctx, owner, target, send, original, actual, create, finishSilently };
}

it.each(['completed', 'failed', 'interrupted'] as const)(
  'releases an orphaned %s turn before sending again in that thread',
  async (status) => {
    const ctx = await setup();
    ctx.finishSilently(status);
    await expect(ctx.send(ctx.owner)).resolves.toMatchObject({ status: 'acknowledged' });
    expect(await ctx.service.getThread(ctx.owner)).toMatchObject({
      title: '之前的工作',
      turns: [{ status }, { status: 'running' }],
    });
    expect(ctx.service.getOperation(ctx.original.clientOperationId)).toMatchObject({
      status: 'acknowledged',
      execution: { ended: true },
    });
    expect(ctx.service.getOperation(ctx.original.clientOperationId).reconciliation).toBeUndefined();
    expect(ctx.codex.starts).toBe(2);
  },
);

it('refreshes a cached running thread so a missed completion does not block follow-up', async () => {
  const ctx = await setup();
  ctx.finishSilently();
  await expect(ctx.service.getThread(ctx.owner)).resolves.toMatchObject({ status: 'completed' });
  await expect(ctx.send(ctx.owner)).resolves.toMatchObject({ status: 'acknowledged' });
  expect(ctx.codex.starts).toBe(2);
});

it('allows new threads without reading or changing an older runtime reservation', async () => {
  const ctx = await setup();
  ctx.codex.reset();
  ctx.finishSilently();
  const fresh = await ctx.create();
  const reads = vi.spyOn(ctx.codex, 'readThread');
  await expect(ctx.send(fresh)).resolves.toMatchObject({ status: 'acknowledged' });
  expect(ctx.store.activeForThread(ctx.owner)?.state).toBe('unknown');
  expect(reads).not.toHaveBeenCalled();
  expect(ctx.codex.resumes).toBe(0);
});

it.each(['running', 'waitingApproval', 'waitingInput'] as const)(
  'keeps a %s task in its thread without blocking another thread',
  async (status) => {
    const ctx = await setup();
    ctx.actual.status = status;
    ctx.actual.turns[0]!.status = status;
    ctx.codex.emit({ type: 'threadStatus', threadId: ctx.owner, status });
    const input = { clientOperationId: operationId(), text: 'blocked' };
    const details = { threadId: ctx.owner };
    await expect(ctx.service.startTurn(ctx.owner, input)).rejects.toMatchObject({
      code: 'THREAD_BUSY',
      details,
    });
    expect(await ctx.service.startTurn(ctx.owner, input)).toMatchObject({
      status: 'failed',
      error: { code: 'THREAD_BUSY', details },
    });
    const marker = ctx.store.activeForThread(ctx.owner);
    await expect(ctx.send(ctx.target)).resolves.toMatchObject({ status: 'acknowledged' });
    expect(ctx.store.activeForThread(ctx.owner)).toEqual(marker);
    expect(ctx.store.activeMarkers()).toHaveLength(2);
    expect(ctx.codex.starts).toBe(2);
  },
);

it.each([
  'idle-only',
  'different-turn',
  'missing-turn-id',
  'read-failure',
  'outside-project',
  'other-active-turn',
])('retains the reservation without sufficient terminal evidence: %s', async (kind) => {
  const ctx = await setup();
  ctx.actual.status = 'idle';
  if (kind === 'different-turn')
    ctx.actual.turns = [
      {
        id: 'different',
        threadId: ctx.owner,
        status: 'completed',
        items: [],
      },
    ];
  if (kind === 'missing-turn-id') {
    // An uncertain dispatch with no known turn must never match an arbitrary completed turn.
    ctx.db.database.run(`UPDATE execution_markers SET turn_id = NULL`);
    ctx.finishSilently();
    delete ctx.actual.turns[0]!.items[0]!.clientId;
  }
  if (kind === 'read-failure')
    vi.spyOn(ctx.codex, 'readThread').mockRejectedValue(new Error('offline'));
  if (kind === 'outside-project') {
    ctx.finishSilently();
    ctx.actual.cwd = ctx.directory;
  }
  if (kind === 'other-active-turn') {
    ctx.finishSilently();
    ctx.actual.turns.push({ id: 'other', threadId: ctx.owner, status: 'running', items: [] });
  }
  await expect(ctx.send(ctx.owner)).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  const marker = ctx.store.activeForThread(ctx.owner);
  expect(marker).toBeDefined();
  await expect(ctx.send(ctx.target)).resolves.toMatchObject({ status: 'acknowledged' });
  expect(ctx.store.activeForThread(ctx.owner)).toEqual(marker);
  expect(ctx.codex.starts).toBe(2);
});

it('does not release a new reservation when an older history read finishes late', async () => {
  const ctx = await setup();
  ctx.finishSilently();
  const snapshot = structuredClone(ctx.actual);
  const gate = deferred<ThreadView>();
  const entered = deferred<void>();
  vi.spyOn(ctx.codex, 'readThread').mockImplementationOnce(() => {
    entered.resolve();
    return gate.promise;
  });
  const pending = ctx.service.getThread(ctx.owner);
  await entered.promise;
  ctx.codex.complete(ctx.owner, 'turn-1');
  const replacement = await ctx.send(ctx.owner);
  gate.resolve(snapshot);
  await expect(pending).resolves.toMatchObject({ status: 'running' });
  expect(ctx.store.activeForThread(ctx.owner)?.operationId).toBe(replacement.clientOperationId);
});

it('ignores terminal history superseded by live events during the read', async () => {
  const ctx = await setup();
  const snapshot = structuredClone(ctx.actual);
  snapshot.status = 'idle';
  snapshot.turns[0]!.status = 'completed';
  vi.spyOn(ctx.codex, 'readThread').mockImplementationOnce(async () => {
    ctx.codex.emit({ type: 'threadStatus', threadId: ctx.owner, status: 'waitingApproval' });
    return snapshot;
  });
  await expect(ctx.send(ctx.owner)).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  expect(ctx.store.activeForThread(ctx.owner)).toBeDefined();
});

it('rechecks runtime ownership after a reset during the history read', async () => {
  const ctx = await setup();
  ctx.finishSilently();
  vi.spyOn(ctx.codex, 'readThread').mockImplementationOnce(async () => {
    ctx.codex.reset();
    return structuredClone(ctx.actual);
  });
  await expect(ctx.send(ctx.owner)).rejects.toMatchObject({ code: 'THREAD_NOT_RESUMED' });
  expect(ctx.store.activeForThread(ctx.owner)?.state).toBe('unknown');
  expect(ctx.codex.starts).toBe(1);
});

it('coalesces concurrent checks and starts only one next turn in the same thread', async () => {
  const ctx = await setup();
  ctx.finishSilently();
  const reads = vi.spyOn(ctx.codex, 'readThread');
  const results = await Promise.allSettled([ctx.send(ctx.owner), ctx.send(ctx.owner)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'THREAD_BUSY' },
  });
  expect(reads).toHaveBeenCalledTimes(1);
  expect(ctx.store.activeMarkers()).toHaveLength(1);
  expect(ctx.codex.starts).toBe(2);
});

it('does not release recovered occupancy on a cold read while another upstream turn is active', async () => {
  const ctx = await setup();
  ctx.finishSilently();
  ctx.actual.turns.push({ id: 'other', threadId: ctx.owner, status: 'running', items: [] });
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  await restarted.getThread(ctx.owner);
  expect(ctx.store.activeForThread(ctx.owner)).toBeDefined();
});

it('dispatches concurrent turns in different threads of the same directory', async () => {
  const ctx = await setup();
  const third = await ctx.create();
  const reads = vi.spyOn(ctx.codex, 'readThread');
  const original = ctx.store.activeForThread(ctx.owner);
  const results = await Promise.all([ctx.send(ctx.target), ctx.send(third)]);
  expect(results.map((entry) => entry.status)).toEqual(['acknowledged', 'acknowledged']);
  expect(reads).not.toHaveBeenCalled();
  expect(ctx.store.activeForThread(ctx.owner)).toEqual(original);
  expect(ctx.store.activeMarkers()).toHaveLength(3);
  expect(ctx.codex.starts).toBe(3);
});

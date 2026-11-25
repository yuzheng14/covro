import { afterEach, expect, it, vi } from 'vitest';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});

async function unloadedThread() {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'saved history' });
  ctx.codex.complete(id, 'turn-1');
  // A notLoaded notification maps to unknown without ending the gateway's ownership.
  ctx.codex.emit({ type: 'threadStatus', threadId: id, status: 'unknown' });
  expect(ctx.service.projection.get(id)).toMatchObject({ status: 'unknown', managed: true });
  expect(ctx.store.activeForThread(id)).toBeUndefined();
  return { ...ctx, id };
}

it('reads managed unknown history, publishes the recovered status and permits the next task', async () => {
  const ctx = await unloadedThread();
  const read = vi.spyOn(ctx.codex, 'readThread');
  const events: ServerMessage[] = [];
  const unsubscribe = ctx.service.subscribeOverview((message) => events.push(message));
  const recovered = await ctx.service.getThread(ctx.id);
  expect(read).toHaveBeenCalledExactlyOnceWith(ctx.id);
  expect(recovered).toMatchObject({ status: 'completed', managed: true });
  expect(recovered.execution).toBeUndefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'event',
      kind: 'threadSummary',
      threadId: ctx.id,
      payload: expect.objectContaining({ status: 'completed' }),
    }),
  );
  unsubscribe();
  expect(ctx.codex.starts).toBe(1);
  expect(ctx.codex.resumes).toBe(0);
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'next task' });
  expect(ctx.codex.starts).toBe(2);
});

it('shares concurrent unknown-history reads and retries after an upstream read failure', async () => {
  const ctx = await unloadedThread();
  const read = vi
    .spyOn(ctx.codex, 'readThread')
    .mockRejectedValueOnce(new Error('read unavailable'));
  await expect(ctx.service.getThread(ctx.id)).rejects.toThrow('read unavailable');
  expect(ctx.service.projection.get(ctx.id)?.status).toBe('unknown');
  const gate = deferred<ThreadView>();
  read.mockReturnValueOnce(gate.promise);
  const first = ctx.service.getThread(ctx.id);
  const second = ctx.service.getThread(ctx.id);
  expect(read).toHaveBeenCalledTimes(2);
  gate.resolve(structuredClone(ctx.codex.threads.get(ctx.id)!));
  expect((await first).status).toBe('completed');
  expect((await second).status).toBe('completed');
  expect(read).toHaveBeenCalledTimes(2);
});

it('does not replace a newer live turn or its execution reservation with a delayed history read', async () => {
  const ctx = await unloadedThread();
  const snapshot = structuredClone(ctx.codex.threads.get(ctx.id)!);
  const gate = deferred<ThreadView>();
  vi.spyOn(ctx.codex, 'readThread').mockReturnValueOnce(gate.promise);
  const pending = ctx.service.getThread(ctx.id);
  // A new live event makes the projection authoritative while the history read is pending.
  ctx.codex.emit({ type: 'threadStatus', threadId: ctx.id, status: 'idle' });
  const nextOperation = operationId();
  await ctx.service.startTurn(ctx.id, { clientOperationId: nextOperation, text: 'new live task' });
  gate.resolve(snapshot);
  const recovered = await pending;
  expect(recovered).toMatchObject({ status: 'running', managed: true });
  expect(recovered.turns.at(-1)).toMatchObject({ id: 'turn-2', status: 'running' });
  expect(recovered.execution).toMatchObject({ operationId: nextOperation, ended: false });
  expect(ctx.store.activeForThread(ctx.id)?.operationId).toBe(nextOperation);
});

it('keeps live approvals and the execution reservation until history confirms the matching turn ended', async () => {
  const ctx = await unloadedThread();
  await ctx.service.getThread(ctx.id);
  const nextOperation = operationId();
  await ctx.service.startTurn(ctx.id, { clientOperationId: nextOperation, text: 'active task' });
  ctx.codex.emit({
    type: 'action',
    action: {
      actionId: 'approval',
      codexEpoch: ctx.codex.epoch,
      rpcId: 1,
      kind: 'command',
      threadId: ctx.id,
      turnId: 'turn-2',
      status: 'pending',
      title: '批准命令',
      options: [{ id: 'accept', label: '允许' }],
    },
  });
  ctx.codex.threads.get(ctx.id)!.status = 'waitingApproval';
  ctx.codex.threads.get(ctx.id)!.turns.at(-1)!.status = 'waitingApproval';
  ctx.codex.emit({ type: 'threadStatus', threadId: ctx.id, status: 'unknown' });
  const recovered = await ctx.service.getThread(ctx.id);
  expect(recovered.status).toBe('waitingApproval');
  expect(recovered.actions).toEqual([
    expect.objectContaining({ actionId: 'approval', status: 'pending' }),
  ]);
  expect(recovered.execution).toMatchObject({ operationId: nextOperation, ended: false });
  await expect(
    ctx.service.reconcileOperation(nextOperation, {
      clientOperationId: operationId(),
      confirmEnded: true,
    }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  ctx.codex.threads.get(ctx.id)!.turns.at(-1)!.status = 'completed';
  ctx.codex.threads.get(ctx.id)!.status = 'completed';
  ctx.codex.emit({ type: 'threadStatus', threadId: ctx.id, status: 'unknown' });
  const ended = await ctx.service.getThread(ctx.id);
  expect(ended.status).toBe('completed');
  expect(ended.execution).toBeUndefined();
  expect(ended.actions).toEqual([
    expect.objectContaining({ actionId: 'approval', status: 'expired' }),
  ]);
});

it('retains unknown status when Codex is unavailable and reads again once it is ready', async () => {
  const ctx = await unloadedThread();
  const read = vi.spyOn(ctx.codex, 'readThread');
  ctx.codex.ready = false;
  expect((await ctx.service.getThread(ctx.id)).status).toBe('unknown');
  expect(read).not.toHaveBeenCalled();
  ctx.codex.ready = true;
  expect((await ctx.service.getThread(ctx.id)).status).toBe('completed');
  expect(read).toHaveBeenCalledOnce();
});

it('releases only the matching execution when history recovers a missed completion event', async () => {
  const ctx = await unloadedThread();
  await ctx.service.getThread(ctx.id);
  const pendingOperation = operationId();
  await ctx.service.startTurn(ctx.id, {
    clientOperationId: pendingOperation,
    text: 'missed completion',
  });
  // The saved history contains completion, but no turn/completed notification was delivered.
  ctx.codex.threads.get(ctx.id)!.turns.at(-1)!.status = 'completed';
  ctx.codex.threads.get(ctx.id)!.status = 'completed';
  ctx.codex.emit({ type: 'threadStatus', threadId: ctx.id, status: 'unknown' });
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({
    operationId: pendingOperation,
    state: 'active',
  });
  const recovered = await ctx.service.getThread(ctx.id);
  expect(recovered.status).toBe('completed');
  expect(recovered.execution).toBeUndefined();
  expect(ctx.service.getOperation(pendingOperation)).toMatchObject({
    status: 'acknowledged',
    execution: { ended: true },
  });
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'after recovery' });
  expect(ctx.codex.starts).toBe(3);
});

it('returns a snapshot while a durable execution is checked, then publishes its recovery', async () => {
  const ctx = await unloadedThread();
  await ctx.service.getThread(ctx.id);
  const pendingOperation = operationId();
  await ctx.service.startTurn(ctx.id, {
    clientOperationId: pendingOperation,
    text: 'missed completion during snapshot',
  });
  const native = ctx.codex.threads.get(ctx.id)!;
  native.turns.at(-1)!.status = 'completed';
  native.status = 'completed';
  const gate = deferred<ThreadView>();
  const reading = vi.spyOn(ctx.codex, 'readThread').mockReturnValueOnce(gate.promise);

  const first = await ctx.service.getThreadSnapshot(ctx.id);
  const second = await ctx.service.getThreadSnapshot(ctx.id);
  expect(first.data.execution?.operationId).toBe(pendingOperation);
  expect(second.data.execution?.operationId).toBe(pendingOperation);
  expect(reading).toHaveBeenCalledTimes(1);

  const changes: ServerMessage[] = [];
  const unsubscribe = await ctx.service.subscribe(
    ctx.id,
    first.cursor,
    (event) => changes.push(event),
    true,
    true,
  );
  gate.resolve(structuredClone(native));
  await vi.waitFor(() => expect(ctx.store.activeForThread(ctx.id)).toBeUndefined());
  expect(changes).toContainEqual(expect.objectContaining({ type: 'event', kind: 'threadPatch' }));
  unsubscribe();
});

import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
function setup() {
  const ctx = harness();
  resources.push(ctx);
  return ctx;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
async function create(ctx: ReturnType<typeof harness>) {
  const operation = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return (operation.result as { threadId: string }).threadId;
}

describe('forking a conversation without taking over its execution', () => {
  it('creates an independent managed conversation with history and its own continuation', async () => {
    const ctx = setup();
    const sourceId = await create(ctx);
    await ctx.service.startTurn(sourceId, { clientOperationId: operationId(), text: 'history' });
    ctx.codex.complete(sourceId, 'turn-1');
    const before = await ctx.service.getThread(sourceId);
    const sourceEvents: ServerMessage[] = [];
    await ctx.service.subscribe(sourceId, undefined, (event) => sourceEvents.push(event));
    sourceEvents.length = 0;
    const fork = vi.spyOn(ctx.codex, 'forkThread');
    const settings = { model: 'fork-model' };
    const input = { clientOperationId: operationId(), settings };
    const result = await ctx.service.forkThread(sourceId, input);
    expect(result).toMatchObject({
      kind: 'thread.fork',
      target: sourceId,
      status: 'acknowledged',
      result: { threadId: 'fork-1', forkedFromId: sourceId },
    });
    expect(ctx.service.getOperation(input.clientOperationId)).toEqual(result);
    expect(fork).toHaveBeenCalledWith(sourceId, realpathSync(ctx.project), settings);
    const forked = await ctx.service.getThread('fork-1');
    expect(forked).toMatchObject({
      id: 'fork-1',
      forkedFromId: sourceId,
      projectId: 'project',
      managed: true,
      status: 'idle',
      turns: [{ id: 'turn-1', threadId: 'fork-1', items: [{ text: 'history' }] }],
      actions: [],
    });
    expect(ctx.store.getThreadLink('fork-1')?.managedEpoch).toBe(ctx.codex.epoch);
    expect((await ctx.service.listThreads('project')).data.map((thread) => thread.id)).toContain(
      'fork-1',
    );
    const forkEvents: ServerMessage[] = [];
    await ctx.service.subscribe('fork-1', undefined, (event) => forkEvents.push(event));
    expect(forkEvents[0]).toMatchObject({ type: 'snapshot', data: { forkedFromId: sourceId } });
    await ctx.service.startTurn('fork-1', {
      clientOperationId: operationId(),
      text: 'new direction',
    });
    expect((await ctx.service.getThread('fork-1')).turns).toHaveLength(2);
    expect(await ctx.service.getThread(sourceId)).toEqual(before);
    expect(
      sourceEvents.filter((event) => event.type === 'event' && event.kind === 'threadPatch'),
    ).toHaveLength(0);
    expect(ctx.codex).toMatchObject({ resumes: 0, interrupts: 0, forks: 1 });
  });

  it('forks an external active conversation without handoff, registering only the new conversation', async () => {
    const ctx = setup();
    const external = threadView('external-cli', ctx.project);
    external.source = 'cli';
    external.status = 'running';
    external.turns = [
      {
        id: 'external-turn',
        threadId: external.id,
        status: 'running',
        items: [{ id: 'history', type: 'userMessage', text: 'external history' }],
      },
    ];
    ctx.codex.threads.set(external.id, external);
    const before = structuredClone(external);
    await ctx.service.forkThread(external.id, { clientOperationId: operationId() });
    expect(ctx.codex.threads.get(external.id)).toEqual(before);
    expect(ctx.service.projection.get(external.id)).toBeUndefined();
    expect(ctx.store.getThreadLink(external.id)).toBeUndefined();
    expect(await ctx.service.getThread('fork-1')).toMatchObject({
      managed: true,
      status: 'idle',
      turns: [{ id: 'external-turn', threadId: 'fork-1', status: 'interrupted' }],
      actions: [],
    });
    expect(ctx.codex).toMatchObject({ forks: 1, resumes: 0, interrupts: 0 });
  });

  it.each(['active', 'unknown'] as const)(
    'runs a fork alongside a %s source without changing its execution',
    async (state) => {
      const ctx = setup();
      const sourceId = await create(ctx);
      const runningId = operationId();
      await ctx.service.startTurn(sourceId, {
        clientOperationId: runningId,
        text: 'still running',
      });
      if (state === 'unknown') ctx.codex.reset();
      const sourceBefore = structuredClone(ctx.service.projection.get(sourceId));
      const linkBefore = ctx.store.getThreadLink(sourceId);
      const markerBefore = ctx.store.activeForThread(sourceId);
      await ctx.service.forkThread(sourceId, { clientOperationId: operationId() });
      expect(ctx.service.projection.get(sourceId)).toEqual(sourceBefore);
      expect(ctx.store.getThreadLink(sourceId)).toEqual(linkBefore);
      expect(ctx.store.activeForThread(sourceId)).toEqual(markerBefore);
      expect(ctx.store.activeForThread('fork-1')).toBeUndefined();
      await expect(
        ctx.service.startTurn('fork-1', {
          clientOperationId: operationId(),
          text: 'run independently in the same workspace',
        }),
      ).resolves.toMatchObject({ status: 'acknowledged' });
      expect(ctx.codex.starts).toBe(2);
      expect(ctx.store.activeForThread(sourceId)).toEqual(markerBefore);
      const forkMarker = ctx.store.activeForThread('fork-1');
      expect(forkMarker).toBeDefined();
      if (state === 'active') {
        ctx.codex.complete(sourceId, 'turn-1');
        expect(ctx.store.activeForThread(sourceId)).toBeUndefined();
        expect(ctx.store.activeForThread('fork-1')).toEqual(forkMarker);
      }
    },
  );

  it('deduplicates concurrent retries and rejects changes to the source or settings', async () => {
    const ctx = setup();
    const sourceId = await create(ctx);
    const gate = deferred<ThreadView>();
    const fork = vi.spyOn(ctx.codex, 'forkThread').mockReturnValueOnce(gate.promise);
    const input = { clientOperationId: operationId(), settings: { model: 'first-model' } };
    const pending = ctx.service.forkThread(sourceId, input);
    expect((await ctx.service.forkThread(sourceId, input)).status).toBe('dispatching');
    await expect(
      ctx.service.forkThread(sourceId, { ...input, settings: { model: 'other-model' } }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(ctx.service.forkThread('other-source', input)).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    });
    gate.resolve(threadView('forked', ctx.project));
    const completed = await pending;
    expect(await ctx.service.forkThread(sourceId, input)).toEqual(completed);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it.each(['lost-result', 'same-id', 'invalid-directory', 'runtime-reset'] as const)(
    'keeps %s results unknown without resending or modifying the source',
    async (failure) => {
      const ctx = setup();
      const sourceId = await create(ctx);
      const before = structuredClone(ctx.service.projection.get(sourceId));
      const fork = vi.spyOn(ctx.codex, 'forkThread').mockImplementationOnce(async () => {
        if (failure === 'lost-result') throw new Error('lost fork result');
        if (failure === 'runtime-reset') ctx.codex.reset();
        return threadView(
          failure === 'same-id' ? sourceId : 'forked',
          failure === 'invalid-directory' ? ctx.directory : ctx.project,
        );
      });
      const input = { clientOperationId: operationId() };
      await expect(ctx.service.forkThread(sourceId, input)).rejects.toMatchObject({
        code: 'RESULT_UNKNOWN',
      });
      expect(ctx.service.getOperation(input.clientOperationId).status).toBe('unknown');
      expect((await ctx.service.forkThread(sourceId, input)).status).toBe('unknown');
      expect(fork).toHaveBeenCalledTimes(1);
      expect(ctx.service.projection.get('forked')).toBeUndefined();
      expect(ctx.store.getThreadLink('forked')).toBeUndefined();
      if (failure !== 'runtime-reset') expect(ctx.service.projection.get(sourceId)).toEqual(before);
    },
  );

  it('records a definite upstream rejection as failed without claiming a new conversation', async () => {
    const ctx = setup();
    const sourceId = await create(ctx);
    const fork = vi
      .spyOn(ctx.codex, 'forkThread')
      .mockRejectedValueOnce(new AppError('UNSUPPORTED_METHOD', 'fork unavailable', 409));
    const input = { clientOperationId: operationId() };
    await expect(ctx.service.forkThread(sourceId, input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_METHOD',
    });
    expect(ctx.service.getOperation(input.clientOperationId)).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_METHOD' },
    });
    expect((await ctx.service.forkThread(sourceId, input)).status).toBe('failed');
    expect(fork).toHaveBeenCalledTimes(1);
    expect(ctx.service.projection.values()).toHaveLength(1);
  });

  it('rejects a source outside configured projects before dispatch and normalizes an allowed symlink', async () => {
    const ctx = setup();
    const outside = threadView('outside', ctx.directory);
    ctx.codex.threads.set(outside.id, outside);
    const dispatch = vi.spyOn(ctx.store, 'dispatch');
    const fork = vi.spyOn(ctx.codex, 'forkThread');
    await expect(
      ctx.service.forkThread(outside.id, { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'PROJECT_OWNERSHIP' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    const nested = join(ctx.project, 'nested');
    mkdirSync(nested);
    const alias = join(ctx.directory, 'project-alias');
    symlinkSync(nested, alias);
    ctx.codex.threads.set('allowed', threadView('allowed', alias));
    await ctx.service.forkThread('allowed', { clientOperationId: operationId() });
    expect(fork).toHaveBeenCalledWith('allowed', realpathSync(nested), undefined);
    expect((await ctx.service.getThread('fork-1')).cwd).toBe(realpathSync(nested));
  });
});

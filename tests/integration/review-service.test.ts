import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { startReviewSchema } from '../../src/shared/validation.js';
import type { TurnView } from '../../src/shared/types.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return { ...ctx, id: (created.result as { threadId: string }).threadId };
}

describe('native inline code review lifecycle', () => {
  it('tracks the native review turn, keeps its lock until a real terminal event, and permits later tasks', async () => {
    const ctx = await setup();
    const input = { clientOperationId: operationId() };
    const result = await ctx.service.startReview(ctx.id, input);
    expect(result).toMatchObject({
      kind: 'review.start',
      status: 'acknowledged',
      result: { threadId: ctx.id, turnId: 'review-1' },
      execution: { turnId: 'review-1', ended: false },
    });
    expect(await ctx.service.startReview(ctx.id, input)).toEqual(result);
    expect(ctx.codex.reviews).toBe(1);
    expect(ctx.codex.starts).toBe(0);
    expect((await ctx.service.getThread(ctx.id)).turns[0]?.items).toMatchObject([
      { type: 'enteredReviewMode' },
    ]);
    await expect(
      ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'too soon' }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await ctx.service.interrupt(ctx.id, {
      clientOperationId: operationId(),
      expectedTurnId: 'review-1',
    });
    expect(ctx.store.activeForThread(ctx.id)).toBeDefined();
    ctx.codex.complete(ctx.id, 'review-1');
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    expect(ctx.service.getOperation(input.clientOperationId).execution?.ended).toBe(true);
    await expect(
      ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'continue' }),
    ).resolves.toMatchObject({ status: 'acknowledged' });
  });

  it('uses the existing approval flow and expires outstanding requests when review ends', async () => {
    const ctx = await setup();
    await ctx.service.startReview(ctx.id, { clientOperationId: operationId() });
    ctx.codex.emit({
      type: 'action',
      action: {
        actionId: 'review-approval',
        codexEpoch: ctx.codex.epoch,
        rpcId: 1,
        kind: 'command',
        threadId: ctx.id,
        turnId: 'review-1',
        status: 'pending',
        title: '审查需要运行命令',
        options: [{ id: 'accept', label: '允许' }],
      },
    });
    expect((await ctx.service.getThread(ctx.id)).status).toBe('waitingApproval');
    await ctx.service.resolveAction('review-approval', {
      clientOperationId: operationId(),
      resolution: { decision: 'accept' },
    });
    expect(ctx.codex.replies).toBe(1);
    expect(ctx.store.activeForThread(ctx.id)).toBeDefined();
    ctx.codex.complete(ctx.id, 'review-1');
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    expect((await ctx.service.getThread(ctx.id)).actions[0]?.status).toBe('expired');
  });

  it('does not revive a review that completes before its delayed receipt and never redispatches the same ID', async () => {
    const ctx = await setup();
    const gate = deferred<TurnView>();
    ctx.codex.startGate = gate;
    const input = { clientOperationId: operationId() };
    const pending = ctx.service.startReview(ctx.id, input);
    await vi.waitFor(() => expect(ctx.codex.reviews).toBe(1));
    expect((await ctx.service.startReview(ctx.id, input)).status).toBe('dispatching');
    const initial = structuredClone(ctx.codex.threads.get(ctx.id)!.turns[0]!);
    ctx.codex.complete(ctx.id, initial.id);
    gate.resolve(initial);
    expect(await pending).toMatchObject({ status: 'acknowledged', execution: { ended: true } });
    expect((await ctx.service.getThread(ctx.id)).turns[0]?.status).toBe('completed');
    expect(ctx.codex.reviews).toBe(1);
    await expect(
      ctx.service.startTurn(ctx.id, { ...input, text: 'different operation' }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it.each([false, true])(
    'retains only uncertain=%s execution failures, without replaying review',
    async (uncertain) => {
      const ctx = await setup();
      const failure = uncertain
        ? new Error('lost review reply')
        : new AppError('NO_GIT_REPOSITORY', '当前目录不是 Git 仓库');
      const review = vi.spyOn(ctx.codex, 'startReview').mockRejectedValueOnce(failure);
      const input = { clientOperationId: operationId() };
      await expect(ctx.service.startReview(ctx.id, input)).rejects.toMatchObject({
        code: uncertain ? 'RESULT_UNKNOWN' : 'NO_GIT_REPOSITORY',
      });
      expect(ctx.service.getOperation(input.clientOperationId).status).toBe(
        uncertain ? 'unknown' : 'failed',
      );
      expect(Boolean(ctx.store.activeForThread(ctx.id))).toBe(uncertain);
      await ctx.service.startReview(ctx.id, input);
      expect(review).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks unmanaged, archived, busy, and unconfirmed runtimes before sending a native review', async () => {
    const ctx = await setup();
    ctx.codex.threads.set('external', threadView('external', ctx.project));
    await expect(
      ctx.service.startReview('external', { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'THREAD_NOT_RESUMED' });
    ctx.service.projection.get(ctx.id)!.archived = true;
    await expect(
      ctx.service.startReview(ctx.id, { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'THREAD_ARCHIVED' });
    ctx.service.projection.get(ctx.id)!.archived = false;
    ctx.codex.compatibility = 'unverified';
    await expect(
      ctx.service.startReview(ctx.id, { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' });
    expect(ctx.codex.reviews).toBe(0);
    ctx.codex.compatibility = 'verified';
    await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'running' });
    await expect(
      ctx.service.startReview(ctx.id, { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect(ctx.codex.reviews).toBe(0);
  });

  it('accepts native targets but never arbitrary prompts, cwd, or settings', () => {
    const input = { clientOperationId: operationId() };
    expect(startReviewSchema.parse(input)).toEqual(input);
    for (const target of [
      { type: 'uncommittedChanges' },
      { type: 'baseBranch', branch: 'main' },
      { type: 'commit', sha: 'abcdef123' },
      { type: 'custom', instructions: 'Check correctness' },
    ])
      expect(startReviewSchema.parse({ ...input, target })).toEqual({ ...input, target });
    for (const extra of [
      { text: 'custom review' },
      { target: { type: 'custom' } },
      { cwd: '/elsewhere' },
      { settings: { sandbox: 'danger-full-access' } },
    ])
      expect(startReviewSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
});

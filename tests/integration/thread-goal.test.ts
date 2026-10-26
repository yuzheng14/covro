import { afterEach, expect, it, vi } from 'vitest';
import { harness, operationId } from './domain-helpers';
import type { GoalMutation, ThreadGoal } from '../../src/shared/thread-goal';
import { goalMutationSchema } from '../../src/shared/validation';
const close: (() => void)[] = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
});
async function setup() {
  const ctx = harness();
  close.push(ctx.close);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  let goal: ThreadGoal | null = null;
  const read = vi.fn(async () => goal);
  const write = vi.fn(async (_: string, mutation: GoalMutation): Promise<ThreadGoal | null> => {
    goal =
      mutation.action === 'clear'
        ? null
        : {
            threadId: id,
            objective: 'Complete the fixture task',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 100,
            ...goal,
            ...mutation,
            updatedAt: 100,
          };
    ctx.codex.emit({ type: 'goal', threadId: id, goal });
    return goal;
  });
  Object.assign(ctx.codex, { getGoal: read, mutateGoal: write });
  return { ...ctx, id, write };
}
it('checks exact snapshots, deduplicates mutations, and rejects stale changes within the same timestamp', async () => {
  const ctx = await setup();
  const initial = await ctx.service.getGoal(ctx.id);
  const input = {
    clientOperationId: operationId(),
    action: 'set' as const,
    objective: 'First objective',
    status: 'paused' as const,
    expectedVersion: initial.version,
    confirm: true as const,
  };
  await ctx.service.mutateGoal(ctx.id, input);
  await ctx.service.mutateGoal(ctx.id, input);
  expect(ctx.write).toHaveBeenCalledTimes(1);
  await expect(
    ctx.service.mutateGoal(ctx.id, {
      ...input,
      clientOperationId: operationId(),
      objective: 'Stale overwrite',
    }),
  ).rejects.toMatchObject({ code: 'GOAL_CONFLICT' });
  expect(ctx.write).toHaveBeenCalledTimes(1);
  expect((await ctx.service.getThread(ctx.id)).goal?.objective).toBe('First objective');
});
it('tracks native goal continuations durably so their real turn can be interrupted', async () => {
  const ctx = await setup();
  const { version } = await ctx.service.getGoal(ctx.id);
  await ctx.service.mutateGoal(ctx.id, {
    clientOperationId: operationId(),
    action: 'set',
    objective: 'Continue',
    status: 'active',
    expectedVersion: version,
    confirm: true,
  });
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
  ctx.codex.emit({
    type: 'turn',
    threadId: ctx.id,
    turn: { id: 'native-goal-turn', threadId: ctx.id, status: 'running', items: [] },
  });
  expect(ctx.store.activeForThread(ctx.id)?.turnId).toBe('native-goal-turn');
  await ctx.service.interrupt(ctx.id, {
    clientOperationId: operationId(),
    expectedTurnId: 'native-goal-turn',
  });
  expect(ctx.codex.interrupts).toBe(1);
  ctx.codex.emit({
    type: 'turn',
    threadId: ctx.id,
    turn: { id: 'native-goal-turn', threadId: ctx.id, status: 'interrupted', items: [] },
  });
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
});
it('permits pausing a running goal but prevents editing it until the current task settles', async () => {
  const ctx = await setup();
  const { version } = await ctx.service.getGoal(ctx.id);
  await ctx.service.mutateGoal(ctx.id, {
    clientOperationId: operationId(),
    action: 'set',
    objective: 'Continue',
    status: 'active',
    expectedVersion: version,
    confirm: true,
  });
  ctx.codex.emit({
    type: 'turn',
    threadId: ctx.id,
    turn: { id: 'active', threadId: ctx.id, status: 'running', items: [] },
  });
  const latest = await ctx.service.getGoal(ctx.id);
  await expect(
    ctx.service.mutateGoal(ctx.id, {
      clientOperationId: operationId(),
      action: 'set',
      objective: 'Other',
      expectedVersion: latest.version,
      confirm: true,
    }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  await ctx.service.mutateGoal(ctx.id, {
    clientOperationId: operationId(),
    action: 'set',
    status: 'paused',
    expectedVersion: latest.version,
    confirm: true,
  });
  expect((await ctx.service.getGoal(ctx.id)).goal?.status).toBe('paused');
});
it('requires explicit confirmation, bounded objectives and positive token budgets', () => {
  const input = {
    clientOperationId: operationId(),
    action: 'set',
    expectedVersion: 'a'.repeat(64),
    objective: 'goal',
    confirm: true,
  };
  expect(goalMutationSchema.safeParse(input).success).toBe(true);
  expect(goalMutationSchema.safeParse({ ...input, confirm: false }).success).toBe(false);
  expect(goalMutationSchema.safeParse({ ...input, tokenBudget: -1 }).success).toBe(false);
  expect(goalMutationSchema.safeParse({ ...input, origin: 'automatic' }).success).toBe(false);
});

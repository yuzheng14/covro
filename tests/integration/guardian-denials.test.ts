import { expect, it } from 'vitest';
import { GuardianDenials } from '../../src/codex/guardian-denials';
import { approveDenialSchema } from '../../src/shared/validation';
import { randomUUID } from 'node:crypto';
const notification = {
  threadId: 'thread',
  turnId: 'turn',
  reviewId: 'review',
  targetItemId: 'item',
  startedAtMs: 100,
  completedAtMs: 200,
  decisionSource: 'agent' as const,
  review: {
    status: 'denied' as const,
    riskLevel: 'high' as const,
    userAuthorization: 'low' as const,
    rationale: 'Needs explicit approval',
  },
  action: {
    type: 'command' as const,
    source: 'unifiedExec' as const,
    command: 'printf safe',
    cwd: '/project',
  },
};
it('retains the server-observed action and consumes its identity once, including repeated events', () => {
  const denials = new GuardianDenials();
  denials.record(notification);
  expect(denials.list('other')).toEqual([]);
  expect(() => denials.take('other', 'review')).toThrow();
  expect(denials.take('thread', 'review')).toMatchObject({
    id: 'review',
    turn_id: 'turn',
    status: 'denied',
    action: { type: 'command', source: 'unified_exec', command: 'printf safe', cwd: '/project' },
  });
  denials.record(notification);
  expect(denials.list('thread')).toEqual([]);
  expect(() => denials.take('thread', 'review')).toThrow();
  denials.clear();
  expect(denials.list('thread')).toEqual([]);
});
it('bounds recent records and requires an explicit confirmation instead of accepting a client event', () => {
  const denials = new GuardianDenials();
  for (let index = 0; index < 12; index++)
    denials.record({ ...notification, reviewId: `review-${index}` });
  expect(denials.list('thread')).toHaveLength(10);
  const input = { clientOperationId: randomUUID(), denialId: 'review' };
  expect(approveDenialSchema.safeParse(input).success).toBe(false);
  expect(
    approveDenialSchema.safeParse({ ...input, confirm: true, event: { action: 'replacement' } })
      .success,
  ).toBe(false);
  expect(approveDenialSchema.safeParse({ ...input, confirm: true }).success).toBe(true);
});

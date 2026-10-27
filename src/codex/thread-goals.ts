import type { ThreadGoal } from '../shared/thread-goal.js';
import { CodexError, isRecord } from './transport.js';
export function readGoal(value: unknown, threadId: string): ThreadGoal | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    typeof value.objective !== 'string' ||
    !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(
      String(value.status),
    ) ||
    !['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    ) ||
    (value.tokenBudget !== null &&
      (typeof value.tokenBudget !== 'number' ||
        !Number.isSafeInteger(value.tokenBudget) ||
        value.tokenBudget <= 0))
  )
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex returned an invalid goal snapshot');
  return value as unknown as ThreadGoal;
}

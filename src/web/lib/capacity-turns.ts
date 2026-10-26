import type { ThreadView, TurnView } from '../../shared/types';
import { isModelCapacityError } from '../../shared/turn-errors';

/** Collapse only linked, consecutive retries that preceded any model or tool output. */
export function capacityTurnViews(thread: ThreadView): TurnView[] {
  const groups: { root: string; turn: TurnView }[] = [];
  for (const turn of thread.turns) {
    const previous = groups.at(-1);
    if (
      turn.retryOf &&
      previous?.root === turn.retryOf &&
      previous.turn.status === 'failed' &&
      previous.turn.items.every((item) => item.type === 'userMessage') &&
      !turn.items.some((item) => item.type === 'userMessage')
    ) {
      previous.turn = { ...turn, items: [...previous.turn.items, ...turn.items] };
    } else groups.push({ root: turn.retryOf ?? turn.id, turn });
  }
  const turns = groups.map((group) => group.turn);
  const last = turns.at(-1);
  if (!last) return turns;
  const retry = thread.capacityRetry;
  if (
    retry ||
    (last.status === 'failed' && isModelCapacityError(last.error ?? '', last.errorCode))
  ) {
    turns[turns.length - 1] = {
      ...last,
      status: retry?.status === 'waiting' || retry?.status === 'retrying' ? 'running' : last.status,
      error: undefined,
      reconnect: undefined,
    };
  }
  return turns;
}

import type { ItemView, PendingUserMessage, ThreadView } from '../../shared/types';
import { capacityTurnViews } from './capacity-turns';

export type SubmittedItem = ItemView & { submissionStatus?: PendingUserMessage['status'] };

export function messageConfirmed(thread: ThreadView, message: PendingUserMessage): boolean {
  return thread.turns.some(
    (turn) =>
      (!message.turnId || message.turnId === turn.id) &&
      turn.items.some((item) => item.type === 'userMessage' && item.clientId === message.id),
  );
}

/** Server snapshots own accepted submissions; browser copies bridge the initial HTTP request. */
export function withPendingMessages(thread: ThreadView, local: PendingUserMessage[]): ThreadView {
  const messages = new Map(
    local
      .filter((message) => message.threadId === thread.id)
      .map((message) => [message.id, message]),
  );
  for (const message of thread.pendingMessages ?? []) messages.set(message.id, message);
  return {
    ...thread,
    pendingMessages: [...messages.values()]
      .filter((message) => !messageConfirmed(thread, message))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
  };
}

/** Overlay submitted content without inserting synthetic turns into native history or controls. */
export function submittedConversation(thread: ThreadView) {
  const turns = thread.turns.map((turn) => ({ ...turn, items: [...turn.items] }));
  const unbound: SubmittedItem[] = [];
  for (const message of thread.pendingMessages ?? []) {
    if (messageConfirmed(thread, message)) continue;
    const item: SubmittedItem = { ...message.item, submissionStatus: message.status };
    const turn = message.turnId ? turns.find((turn) => turn.id === message.turnId) : undefined;
    if (!turn) unbound.push(item);
    else if (message.kind === 'steer') turn.items.push(item);
    else turn.items.unshift(item);
  }
  return { turns: capacityTurnViews({ ...thread, turns }), unbound };
}

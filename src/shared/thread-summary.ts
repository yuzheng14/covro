import type { ThreadSummary, ThreadView } from './types.js';
import { pendingAttention } from './thread-attention.js';

/** Overview messages deliberately omit conversation content and control payloads. */
export function toThreadSummary(thread: ThreadView): ThreadSummary {
  const lastTurn = thread.turns.at(-1);
  return {
    id: thread.id,
    ...(thread.archived === undefined ? {} : { archived: thread.archived }),
    ...(thread.forkedFromId === undefined ? {} : { forkedFromId: thread.forkedFromId }),
    projectId: thread.projectId,
    source: thread.source,
    originator: thread.originator ?? null,
    title: thread.title,
    status: thread.status,
    managed: thread.managed,
    ...(thread.historyVisible === undefined ? {} : { historyVisible: thread.historyVisible }),
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    pendingActionCount: thread.actions.filter(
      (action) => action.status === 'pending' || action.status === 'responding',
    ).length,
    pendingQuestionCount: pendingAttention(thread).filter(
      (request) => request.target.kind === 'question',
    ).length,
    ...(lastTurn === undefined ? {} : { lastTurnId: lastTurn.id, lastTurnStatus: lastTurn.status }),
  };
}

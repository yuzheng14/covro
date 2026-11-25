import { createHash } from 'node:crypto';
import { asyncQuestionId } from '../shared/async-questions.js';
import {
  canTrackQuestions,
  indexQuestionReplies,
  questionAnswer,
  type PendingQuestion,
  type PendingQuestionState,
} from '../shared/pending-questions.js';
import type { ThreadView, TurnView } from '../shared/types.js';

export function questionEvidence(turn: TurnView): TurnView {
  return {
    id: turn.id,
    threadId: turn.threadId,
    status: turn.status,
    items: turn.items
      .filter(
        (item) =>
          (item.type === 'agentMessage' && item.questions?.length) || item.questionReplies?.length,
      )
      .map(({ id, type, questions, questionReplies }) => ({
        id,
        type,
        questions: questions?.map(({ title }) => ({ title, options: null })),
        questionReplies,
      })),
  };
}

export interface QuestionHistory {
  epoch: string;
  cursor: string;
  status: PendingQuestionState['history'];
  turns: Map<string, { turn: TurnView; cursor: string }>;
  observed?: TurnView[];
  retryAt?: number;
}

export function pendingQuestionCatalog(thread: ThreadView, history?: QuestionHistory) {
  const turns = new Map<string, TurnView>();
  for (const { turn } of history?.turns.values() ?? []) turns.set(turn.id, turn);
  for (const turn of thread.turns) {
    const old = turns.get(turn.id);
    if (!old) turns.set(turn.id, turn);
    else turns.set(turn.id, mergeQuestionEvidence(old, turn));
  }
  if (history?.observed) {
    // A fresh native read is ordered and may know about replies from a different client.
    // Keep events that arrived in the projection during that read.
    const projected = new Map(turns);
    turns.clear();
    for (const native of history.observed) {
      const live = projected.get(native.id);
      turns.set(native.id, live ? mergeQuestionEvidence(native, live) : native);
      projected.delete(native.id);
    }
    for (const [id, turn] of projected) turns.set(id, turn);
  }
  const ordered = [...turns.values()];
  const replies = indexQuestionReplies(ordered);
  const positions = new Map(ordered.map((turn, index) => [turn.id, index + 1]));
  const data: PendingQuestion[] = [];
  let groups = 0;
  const summary = (title: string) => title.slice(0, 360).replace(/\s+/g, ' ').trim();
  if (!thread.archived) {
    for (const action of thread.actions) {
      if (action.kind !== 'questions' || !['pending', 'responding'].includes(action.status))
        continue;
      for (const question of action.questions ?? []) {
        data.push({
          id: question.id,
          turnId: action.turnId,
          turnNumber: action.turnId ? positions.get(action.turnId) : undefined,
          summary: summary(question.question || question.header),
          target: { kind: 'action', id: action.actionId },
          state: action.status === 'responding' ? 'responding' : undefined,
        });
      }
    }
    for (const turn of ordered.slice().reverse()) {
      if (!canTrackQuestions(turn.status)) continue;
      for (const item of turn.items) {
        if (item.type !== 'agentMessage') continue;
        let pending = false;
        for (const [index, question] of (item.questions ?? []).entries()) {
          const id = asyncQuestionId(item.id, index);
          const state = thread.questionTracking?.[id]?.status;
          if (
            state === 'dismissed' ||
            questionAnswer(
              [...(replies.get(id) ?? []), ...(replies.get(item.id) ?? [])],
              id,
              item.id,
              question.title,
            ) !== undefined
          )
            continue;
          pending = true;
          data.push({
            id,
            turnId: turn.id,
            turnNumber: positions.get(turn.id),
            summary: summary(question.title),
            target: { kind: 'question', id: item.id },
            state,
          });
        }
        if (pending) groups++;
      }
    }
  }
  const status =
    history?.status ?? (thread.history?.olderCursor && !thread.archived ? 'loading' : 'ready');
  // An offset into the returned window would change as earlier pages arrive.
  if (status !== 'ready') for (const row of data) delete row.turnNumber;
  const state: PendingQuestionState = {
    count: data.length,
    groups,
    ...(status === 'ready' ? { turnCount: ordered.length } : {}),
    version: createHash('sha256').update(JSON.stringify(data)).digest('base64url'),
    history: status,
  };
  return { data, state, replies };
}

function mergeQuestionEvidence(earlier: TurnView, live: TurnView): TurnView {
  return {
    ...live,
    items: [...new Map([...earlier.items, ...live.items].map((item) => [item.id, item])).values()],
  };
}

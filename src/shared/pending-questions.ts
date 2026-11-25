import type { AsyncQuestionReply, ThreadView, TurnView } from './types.js';

export interface PendingQuestion {
  id: string;
  turnId?: string;
  turnNumber?: number;
  summary: string;
  target: { kind: 'question' | 'action'; id: string };
  state?: 'submitting' | 'unknown' | 'responding';
}

export interface PendingQuestionState {
  count: number;
  groups: number;
  turnCount?: number;
  version: string;
  history: 'loading' | 'ready' | 'error';
}

export interface PendingQuestionsPage {
  data: PendingQuestion[];
  nextCursor: string | null;
  history: PendingQuestionState['history'];
}

export interface QuestionLocation {
  turn?: TurnView;
  turnNumber?: number;
  cursor?: string;
  replies?: AsyncQuestionReply[];
}

export function canTrackQuestions(status: TurnView['status']) {
  return status !== 'failed' && status !== 'interrupted';
}

export function questionAnswer(
  replies: AsyncQuestionReply[],
  id: string,
  itemId: string,
  title: string,
) {
  return (
    replies.find((reply) => reply.questionItemId === id)?.answer ??
    replies.find((reply) => reply.questionItemId === itemId && reply.question === title)?.answer
  );
}

/** Index by source so finding one answer never scans the rest of the conversation. */
export function indexQuestionReplies(turns: Pick<ThreadView, 'turns'>['turns']) {
  const replies = new Map<string, AsyncQuestionReply[]>();
  for (const turn of turns)
    for (const item of turn.items)
      for (const reply of item.questionReplies ?? []) {
        const group = replies.get(reply.questionItemId);
        if (group) group.push(reply);
        else replies.set(reply.questionItemId, [reply]);
      }
  return replies;
}

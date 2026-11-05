import { asyncQuestionId } from './async-questions.js';
import type { AttentionRequest, ThreadView } from './types.js';

/** Uses request identities only; prompts, answers and approval details stay in the page. */
export function pendingAttention(thread: ThreadView): AttentionRequest[] {
  if (thread.archived) return [];
  const metadata = { threadId: thread.id, projectId: thread.projectId, title: thread.title };
  const requests: AttentionRequest[] = thread.actions.flatMap((action) => {
    if (action.status !== 'pending' || action.kind === 'unsupported') return [];
    const answer =
      action.kind === 'questions' ||
      (action.kind === 'elicitation' && !action.elicitation?.approval);
    return [
      {
        ...metadata,
        kind: answer ? 'answer' : 'approval',
        target: { kind: 'action', id: action.actionId },
      },
    ];
  });
  const replies = thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => item.questionReplies ?? []),
  );
  for (const turn of thread.turns) {
    if (turn.status === 'failed' || turn.status === 'interrupted') continue;
    for (const item of turn.items) {
      if (!item.questions?.length || item.type !== 'agentMessage') continue;
      const unanswered = item.questions.some(
        (question, index) =>
          thread.questionTracking?.[asyncQuestionId(item.id, index)]?.status !== 'dismissed' &&
          !replies.some(
            (reply) =>
              reply.questionItemId === asyncQuestionId(item.id, index) ||
              (reply.questionItemId === item.id && reply.question === question.title),
          ),
      );
      if (unanswered)
        requests.push({ ...metadata, kind: 'answer', target: { kind: 'question', id: item.id } });
    }
  }
  return requests;
}

export function attentionKey(request: Pick<AttentionRequest, 'threadId' | 'target'>): string {
  return JSON.stringify(['attention', request.threadId, request.target.kind, request.target.id]);
}

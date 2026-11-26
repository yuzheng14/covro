import { asyncQuestionId } from './async-questions.js';
import { indexQuestionReplies, questionAnswer } from './pending-questions.js';
import type { AsyncQuestionReply, AttentionRequest, ThreadView } from './types.js';

/** Uses request identities only; prompts, answers and approval details stay in the page. */
export function pendingAttention(
  thread: ThreadView,
  locatedReplies: AsyncQuestionReply[] = [],
  hiddenQuestionIds?: ReadonlySet<string>,
): AttentionRequest[] {
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
  const replies = indexQuestionReplies(thread.turns);
  for (const reply of locatedReplies) {
    const previous = replies.get(reply.questionItemId);
    if (previous) previous.push(reply);
    else replies.set(reply.questionItemId, [reply]);
  }
  for (const turn of thread.turns) {
    if (turn.status === 'failed' || turn.status === 'interrupted') continue;
    for (const item of turn.items) {
      if (!item.questions?.length || item.type !== 'agentMessage') continue;
      const unanswered = item.questions.some((question, index) => {
        const id = asyncQuestionId(item.id, index);
        return (
          !hiddenQuestionIds?.has(id) &&
          thread.questionTracking?.[id]?.status !== 'dismissed' &&
          questionAnswer(
            [...(replies.get(id) ?? []), ...(replies.get(item.id) ?? [])],
            id,
            item.id,
            question.title,
          ) === undefined
        );
      });
      if (unanswered)
        requests.push({ ...metadata, kind: 'answer', target: { kind: 'question', id: item.id } });
    }
  }
  return requests;
}

export function attentionKey(request: Pick<AttentionRequest, 'threadId' | 'target'>): string {
  return JSON.stringify(['attention', request.threadId, request.target.kind, request.target.id]);
}

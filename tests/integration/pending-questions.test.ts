import { afterEach, expect, it } from 'vitest';
import type { CodexClient } from '../../src/codex/types.js';
import { asyncQuestionId } from '../../src/shared/async-questions.js';
import type { PendingQuestion } from '../../src/shared/pending-questions.js';
import type { TurnView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const contexts: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.close();
});

async function paged(questionCount: number) {
  const ctx = harness();
  contexts.push(ctx);
  const created = await ctx.codex.createThread(ctx.project);
  const thread = ctx.codex.threads.get(created.id)!;
  const turn = (id: string, items: TurnView['items'] = []): TurnView => ({
    id,
    threadId: thread.id,
    status: 'completed',
    items,
  });
  const old = turn('old', [
    {
      id: 'question-item',
      type: 'agentMessage',
      questions: Array.from({ length: questionCount }, (_, index) => ({
        title: `Question ${index + 1}?`,
        options: null,
      })),
    },
  ]);
  const reply = turn('reply', [
    {
      id: 'external-reply',
      type: 'userMessage',
      questionReplies: [
        {
          questionItemId: asyncQuestionId('question-item', 0),
          question: 'Question 1?',
          answer: 'Recorded elsewhere',
        },
      ],
    },
  ]);
  const latest = turn('latest');
  thread.turns = [old, reply, latest];
  const read = { hold: undefined as Promise<void> | undefined, moved: false };
  const codex: CodexClient = ctx.codex;
  codex.readThreadPage = async (_id, cursor) => {
    if (cursor === 'older') await read.hold;
    return structuredClone({
      ...thread,
      turns:
        cursor === 'older' ? [read.moved ? reply : old] : cursor === 'middle' ? [reply] : [latest],
      history: {
        olderCursor: cursor === 'older' ? null : cursor === 'middle' ? 'older' : 'middle',
      },
    });
  };
  codex.readThreadTurnItems = async (_id, turnId) => (turnId === old.id ? old.items : []);
  await ctx.service.getThreadSnapshot(thread.id);
  await expect
    .poll(async () => (await ctx.service.getPendingQuestions(thread.id)).history)
    .toBe('ready');
  return { ...ctx, thread, old, read };
}

const target = (row: PendingQuestion) => ({
  kind: row.target.kind,
  id: row.target.id,
  turnId: row.turnId,
  questionId: row.id,
});

it('pages complete pending rows after applying external replies and rejects a changed continuation', async () => {
  const { service, thread, old, read } = await paged(43);
  const first = await service.getPendingQuestions(thread.id);
  expect(first.data).toHaveLength(40);
  expect(first.data[0]).toMatchObject({ summary: 'Question 2?', turnNumber: 1, turnId: old.id });
  const second = await service.getPendingQuestions(thread.id, first.nextCursor!);
  expect(second.data.map((row) => row.summary)).toEqual(['Question 42?', 'Question 43?']);
  expect(second.nextCursor).toBeNull();
  read.moved = true;
  const location = await service.locateQuestion(thread.id, target(first.data[0]!));
  expect(location.turn?.id).toBe(old.id);
  expect(location.cursor).toBeUndefined();
  expect(location.replies).toEqual([expect.objectContaining({ answer: 'Recorded elsewhere' })]);
  await service.dismissQuestions(thread.id, {
    clientOperationId: operationId(),
    questionIds: [first.data[0]!.id],
  });
  await expect(service.getPendingQuestions(thread.id, first.nextCursor!)).rejects.toMatchObject({
    code: 'QUESTION_LIST_CHANGED',
  });
  expect((await service.getThread(thread.id)).turns.map((turn) => turn.id)).toEqual(['latest']);
});

it('rejects a mismatched turn and a location that expires during the history read', async () => {
  const { service, thread, read } = await paged(3);
  const row = (await service.getPendingQuestions(thread.id)).data[0]!;
  await expect(
    service.locateQuestion(thread.id, { ...target(row), turnId: 'latest' }),
  ).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
  const hold = deferred<void>();
  read.hold = hold.promise;
  const finding = service.locateQuestion(thread.id, target(row));
  const rejection = expect(finding).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
  await service.dismissQuestions(thread.id, {
    clientOperationId: operationId(),
    questionIds: [row.id],
  });
  hold.resolve();
  await rejection;
  const remaining = await service.getPendingQuestions(thread.id);
  expect(remaining.data.map((question) => question.summary)).toEqual(['Question 3?']);
  expect((await service.getThread(thread.id)).pendingQuestions).toMatchObject({
    count: 1,
    groups: 1,
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { harness, deferred, operationId } from './domain-helpers.js';
import { GatewayService } from '../../src/server/service.js';
import { asyncQuestionId, encodeQuestionReplies } from '../../src/shared/async-questions.js';
import { pendingAttention } from '../../src/shared/thread-attention.js';
import { toThreadSummary } from '../../src/shared/thread-summary.js';
import type { PendingAction } from '../../src/shared/types.js';
import { questionAnswers } from '../../src/shared/question-resolution.js';
import { captureLogger } from '../fixtures/logging.js';
import { withLogContext } from '../../src/logging/context.js';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileToken } from '../../src/shared/file-references.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});
async function setup(status: 'completed' | 'running' = 'completed') {
  const logs = captureLogger();
  const ctx = harness(logs.logger);
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const thread = ctx.codex.threads.get(id)!;
  thread.turns.push({
    id: 'source-turn',
    threadId: id,
    status,
    items: [
      {
        id: 'q1',
        type: 'agentMessage',
        delivery: 'async',
        questions: [
          { title: 'First?', options: ['A', 'B'] },
          { title: 'Second?', options: null },
        ],
      },
      {
        id: 'q2',
        type: 'agentMessage',
        delivery: 'async',
        questions: [{ title: 'Third?', options: null }],
      },
    ],
  });
  thread.status = status;
  ctx.codex.emit({ type: 'turn', threadId: id, turn: structuredClone(thread.turns[0]!) });
  const ids = [asyncQuestionId('q1', 0), asyncQuestionId('q1', 1), asyncQuestionId('q2', 0)];
  return { ...ctx, id, thread, ids, logs };
}
const dismissInput = (questionIds: string[]) => ({ clientOperationId: operationId(), questionIds });
const replyInput = (id: string) => ({
  clientOperationId: operationId(),
  text: encodeQuestionReplies([{ questionItemId: id, question: 'First?', answer: 'A' }]),
});

it('ends selected tracking durably without native submission, while other groups keep attention', async () => {
  const ctx = await setup();
  expect(toThreadSummary(await ctx.service.getThread(ctx.id)).pendingQuestionCount).toBe(2);
  const input = dismissInput([ctx.ids[0]!]);
  await withLogContext({ requestId: 'request-dismiss' }, () =>
    ctx.service.dismissQuestions(ctx.id, input),
  );
  expect((await ctx.service.dismissQuestions(ctx.id, input)).status).toBe('acknowledged');
  expect(ctx.logs.records.filter((record) => record.event === 'question.dismissed')).toEqual([
    expect.objectContaining({
      component: 'question_tracking',
      requestId: 'request-dismiss',
      operationId: input.clientOperationId,
      threadId: ctx.id,
      count: 1,
      state: 'dismissed',
    }),
  ]);
  let view = await ctx.service.getThread(ctx.id);
  expect(view.status).toBe('completed');
  expect(view.questionTracking?.[ctx.ids[0]!]?.status).toBe('dismissed');
  expect(toThreadSummary(view).pendingQuestionCount).toBe(2);
  await ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[1]!]));
  view = await ctx.service.getThread(ctx.id);
  expect(pendingAttention(view).map((r) => r.target.id)).toEqual(['q2']);
  expect(ctx.service.getThreadAttention(ctx.id).map((r) => r.target.id)).toEqual(['q2']);
  expect([ctx.codex.starts, ctx.codex.steers, ctx.codex.interrupts, ctx.codex.replies]).toEqual([
    0, 0, 0, 0,
  ]);
  await ctx.service.shutdown();
  await ctx.codex.start();
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  expect(toThreadSummary(await restarted.getThread(ctx.id)).pendingQuestionCount).toBe(1);
  await restarted.dismissQuestions(ctx.id, dismissInput([ctx.ids[2]!]));
  expect(toThreadSummary(await restarted.getThread(ctx.id)).pendingQuestionCount).toBe(0);
});

it('keeps a running task running and rejects unknown question identities without partial writes', async () => {
  const ctx = await setup('running');
  await expect(
    ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!, 'unknown'])),
  ).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' });
  expect((await ctx.service.getThread(ctx.id)).questionTracking).toEqual({});
  expect(ctx.logs.records).not.toContainEqual(
    expect.objectContaining({ event: 'question.dismissed' }),
  );
  await ctx.service.dismissQuestions(ctx.id, dismissInput(ctx.ids));
  expect((await ctx.service.getThread(ctx.id)).status).toBe('running');
  expect(ctx.codex.interrupts).toBe(0);
});

it('rejects stale answers after local disposition without creating a new turn', async () => {
  const ctx = await setup();
  await ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!]));
  await expect(ctx.service.startTurn(ctx.id, replyInput(ctx.ids[0]!))).rejects.toMatchObject({
    code: 'QUESTION_CONFLICT',
  });
  expect(ctx.codex.starts).toBe(0);
});

it.each(['start', 'steer'] as const)(
  'validates referenced files before claiming answers and keeps duplicate protection: %s',
  async (mode) => {
    const ctx = await setup();
    let expectedTurnId = '';
    if (mode === 'steer') {
      const running = await ctx.service.startTurn(ctx.id, {
        clientOperationId: operationId(),
        text: 'Continue the task',
      });
      expectedTurnId = (running.result as { turnId: string }).turnId;
    }
    const cwd = realpathSync(ctx.project);
    const path = 'answer.md';
    const token = fileToken(path);
    const reply = { questionItemId: ctx.ids[0]!, question: 'First?', answer: token };
    const text = encodeQuestionReplies([reply]);
    const start = text.indexOf(token);
    const files = [{ cwd, path, start, end: start + token.length }];
    const startTurn = vi.spyOn(ctx.codex, 'startTurn');
    const steerTurn = vi.spyOn(ctx.codex, 'steerTurn');
    const send = () => {
      const input = { clientOperationId: operationId(), text, files };
      return mode === 'start'
        ? ctx.service.startTurn(ctx.id, input)
        : ctx.service.steer(ctx.id, { ...input, expectedTurnId });
    };
    await expect(send()).rejects.toMatchObject({ code: 'FILE_REFERENCE_NOT_FOUND' });
    expect((await ctx.service.getThread(ctx.id)).questionTracking).toEqual({});
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();

    writeFileSync(join(cwd, path), 'answer');
    const operation = await send();
    const submitted =
      mode === 'start' ? startTurn.mock.calls[0]?.[2] : steerTurn.mock.calls[0]?.[2];
    expect(submitted).toBe(encodeQuestionReplies([{ ...reply, answer: path }]));
    if (mode === 'start')
      ctx.codex.complete(ctx.id, (operation.result as { turnId: string }).turnId);
    await expect(send()).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' });
    expect(startTurn.mock.calls.length + steerTurn.mock.calls.length).toBe(1);
  },
);

it('honors native answers from another client and never overwrites them with a local dismissal', async () => {
  const ctx = await setup();
  ctx.thread.turns[0]!.items.push({
    id: 'external',
    type: 'userMessage',
    questionReplies: [{ questionItemId: ctx.ids[0]!, question: 'First?', answer: 'B' }],
  });
  await ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!]));
  const view = await ctx.service.getThread(ctx.id);
  expect(view.questionTracking?.[ctx.ids[0]!]).toBeUndefined();
  expect(view.turns[0]!.items.at(-1)?.questionReplies?.[0]?.answer).toBe('B');
  await expect(ctx.service.startTurn(ctx.id, replyInput(ctx.ids[0]!))).rejects.toMatchObject({
    code: 'QUESTION_CONFLICT',
  });
  expect(ctx.codex.starts).toBe(0);
});

it.each([false, true])(
  'protects a claimed answer from dismissal and duplicate sending; uncertain=%s',
  async (uncertain) => {
    const ctx = await setup();
    ctx.codex.startGate = deferred();
    const input = replyInput(ctx.ids[0]!);
    const result = ctx.service.startTurn(ctx.id, input).catch((e: unknown) => e);
    await vi.waitFor(() => expect(ctx.codex.starts).toBe(1));
    await expect(
      ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!])),
    ).rejects.toMatchObject({ code: 'QUESTION_BUSY' });
    const error = Object.assign(new Error('submit failed'), { uncertain });
    ctx.codex.startGate.reject(error);
    await result;
    expect(ctx.logs.records).toContainEqual(
      expect.objectContaining({
        event: 'question.reply_claimed',
        operationId: input.clientOperationId,
        threadId: ctx.id,
        count: 1,
      }),
    );
    expect(ctx.logs.records.filter((record) => record.event === 'question.reply_released')).toEqual(
      uncertain
        ? []
        : [
            expect.objectContaining({
              operationId: input.clientOperationId,
              threadId: ctx.id,
              count: 1,
              reason: 'submission_failed',
            }),
          ],
    );
    expect(JSON.stringify(ctx.logs.records)).not.toContain('submit failed');
    if (uncertain) {
      expect((await ctx.service.getThread(ctx.id)).questionTracking?.[ctx.ids[0]!]?.status).toBe(
        'unknown',
      );
      await expect(
        ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!])),
      ).rejects.toMatchObject({ code: 'QUESTION_BUSY' });
    } else {
      expect((await ctx.service.getThread(ctx.id)).questionTracking?.[ctx.ids[0]!]).toBeUndefined();
      await ctx.service.dismissQuestions(ctx.id, dismissInput([ctx.ids[0]!]));
    }
  },
);

it('records native partial skips and restores their history with secret answers redacted', async () => {
  const ctx = await setup('running');
  const action: PendingAction = {
    actionId: 'sync',
    codexEpoch: ctx.codex.epoch,
    rpcId: 9,
    threadId: ctx.id,
    turnId: 'source-turn',
    status: 'pending',
    kind: 'questions',
    title: 'Questions',
    options: [],
    questions: [
      {
        id: 'a',
        header: 'A',
        question: 'A?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'A', description: '' }],
      },
      { id: 'b', header: 'B', question: 'B?', isOther: true, isSecret: true, options: [] },
    ],
  };
  ctx.codex.emit({ type: 'action', action });
  const resolution = { answers: { b: ['sensitive answer'] }, skippedQuestionIds: ['a'] };
  expect(questionAnswers(action.questions!, resolution)).toEqual({
    a: { answers: [] },
    b: { answers: ['sensitive answer'] },
  });
  await ctx.service.resolveAction('sync', { clientOperationId: operationId(), resolution });
  expect(ctx.logs.records.filter((record) => record.event === 'question.action_saved')).toEqual([
    expect.objectContaining({
      actionId: 'sync',
      threadId: ctx.id,
      turnId: 'source-turn',
      state: 'expired',
      count: 2,
    }),
    expect.objectContaining({
      actionId: 'sync',
      threadId: ctx.id,
      turnId: 'source-turn',
      state: 'responded',
      count: 2,
    }),
  ]);
  expect(JSON.stringify(ctx.logs.records)).not.toMatch(/sensitive answer|A\?|B\?|••••/);
  expect(
    (await ctx.service.getThread(ctx.id)).actions.find((a) => a.actionId === 'sync'),
  ).toMatchObject({ status: 'responded', questionAnswers: { a: [], b: ['••••'] } });
  await ctx.service.shutdown();
  await ctx.codex.start();
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  expect(
    (await restarted.getThread(ctx.id)).actions.find((a) => a.actionId === 'sync'),
  ).toMatchObject({ status: 'responded', questionAnswers: { a: [], b: ['••••'] } });
});

it.each(['pending', 'external'] as const)(
  'restores observed native request history without reviving a live request: %s',
  async (state) => {
    const ctx = await setup('running');
    const action: PendingAction = {
      actionId: 'observed',
      codexEpoch: ctx.codex.epoch,
      rpcId: 10,
      threadId: ctx.id,
      turnId: 'source-turn',
      status: 'pending',
      kind: 'questions',
      title: 'Question',
      options: [],
      questions: [
        { id: 'q', header: 'Q', question: 'Choose?', isOther: true, isSecret: false, options: [] },
      ],
    };
    ctx.codex.emit({ type: 'action', action });
    if (state === 'external') ctx.codex.emit({ type: 'actionResolved', actionId: action.actionId });
    await ctx.service.shutdown();
    await ctx.codex.start();
    const restarted = new GatewayService({
      store: ctx.store,
      projects: ctx.projects,
      codex: ctx.codex,
    });
    const view = await restarted.getThread(ctx.id);
    expect(view.actions.find((a) => a.actionId === action.actionId)).toMatchObject({
      status: state === 'external' ? 'responded' : 'expired',
    });
    expect(toThreadSummary(view).pendingActionCount).toBe(0);
    expect(ctx.codex.replies).toBe(0);
  },
);

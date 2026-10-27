import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoReviewView, ServerMessage, ThreadView } from '../../src/shared/types.js';
import { harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
function setup() {
  const context = harness();
  resources.push(context);
  return context;
}
afterEach(async () => {
  for (const context of resources.splice(0)) {
    await context.service.shutdown();
    context.close();
  }
});

function review(overrides: Partial<AutoReviewView> = {}): AutoReviewView {
  return {
    reviewId: 'review-1',
    targetItemId: 'command-1',
    status: 'inProgress',
    actionLabel: '执行命令',
    actionSummary: 'git push origin review-branch',
    startedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}
function reviews(thread: ThreadView) {
  return thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => (item.autoReview ? [item.autoReview] : [])),
  );
}
async function start(context: ReturnType<typeof harness>) {
  const created = await context.service.createThread('project', {
    clientOperationId: operationId(),
  });
  const { threadId } = created.result as { threadId: string };
  await context.service.startTurn(threadId, {
    clientOperationId: operationId(),
    text: '显示自动审核结果',
  });
  return { threadId, turnId: context.codex.threads.get(threadId)!.turns[0]!.id };
}

// These tests emit through CodexClient's public event boundary. They exercise GatewayService
// routing, project isolation, snapshots, and execution recovery rather than Projection helpers.
describe('automatic reviews through GatewayService', () => {
  it('publishes review progress and decisions without resolving a human request or changing execution state', async () => {
    const context = setup();
    const { threadId, turnId } = await start(context);
    const received: ServerMessage[] = [];
    const unsubscribe = await context.service.subscribe(threadId, undefined, (message) =>
      received.push(message),
    );
    const marker = context.store.activeForThread(threadId);
    const respond = vi.spyOn(context.codex, 'respond');
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: review() });

    const running = await context.service.getThread(threadId);
    expect(running.status).toBe('running');
    expect(running.turns[0]!.status).toBe('running');
    expect(running.actions).toEqual([]);
    expect(reviews(running)).toEqual([review()]);
    expect((await context.service.listThreadSummaries('project')).data[0]!.pendingActionCount).toBe(
      0,
    );

    // An automatic decision must neither dismiss nor answer an unrelated pending human approval.
    context.codex.emit({
      type: 'action',
      action: {
        actionId: 'human-approval',
        codexEpoch: context.codex.epoch,
        rpcId: 1,
        kind: 'command',
        threadId,
        turnId,
        status: 'pending',
        title: '手动审批',
        options: [{ id: 'accept', label: '允许' }],
      },
    });
    const denied = review({
      status: 'denied',
      rationale: '没有获得发布该分支的授权。',
      completedAtMs: 1_800_000_000_500,
    });
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: denied });

    const waiting = await context.service.getThread(threadId);
    expect(waiting.status).toBe('waitingApproval');
    expect(waiting.turns[0]!.status).toBe('waitingApproval');
    expect(waiting.actions).toMatchObject([{ actionId: 'human-approval', status: 'pending' }]);
    expect(reviews(waiting)).toEqual([denied]);
    expect((await context.service.listThreadSummaries('project')).data[0]!.pendingActionCount).toBe(
      1,
    );
    expect(context.store.activeForThread(threadId)).toEqual(marker);
    expect(respond).not.toHaveBeenCalled();
    expect(context.codex.replies).toBe(0);
    const threadEvents = received.filter(
      (message) => message.type === 'event' && message.kind === 'threadPatch',
    );
    expect(threadEvents.at(-1)).toMatchObject({
      type: 'event',
      threadId,
      payload: {
        turns: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({ value: expect.objectContaining({ autoReview: denied }) }),
            ]),
          },
        ],
      },
    });
    unsubscribe();
  });

  it('recovers a review received before its registered thread and turn become available', async () => {
    const context = setup();
    const threadId = 'early-thread';
    const turnId = 'early-turn';
    const completed = review({
      status: 'approved',
      rationale: '已明确授权此项操作。',
      completedAtMs: 1_800_000_000_500,
    });
    const before = context.service.events.cursor();
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: review() });
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: completed });
    expect(context.service.projection.get(threadId)).toBeUndefined();
    expect(context.service.events.cursor()).toEqual(before);

    const thread = threadView(threadId, context.project);
    context.codex.threads.set(threadId, thread);
    context.codex.emit({ type: 'thread', thread });
    expect((await context.service.getThread(threadId)).turns).toEqual([]);
    context.codex.emit({
      type: 'turn',
      threadId,
      turn: { id: turnId, threadId, status: 'running', items: [] },
    });
    const recovered = await context.service.getThread(threadId);
    expect(recovered.projectId).toBe('project');
    expect(reviews(recovered)).toEqual([completed]);
    expect(recovered.status).toBe('running');
    expect(recovered.actions).toEqual([]);
    expect(context.codex.replies).toBe(0);
  });

  it('does not expose reviews from threads outside registered projects', async () => {
    const context = setup();
    const outside = join(context.directory, 'outside-project');
    mkdirSync(outside);
    const thread = threadView('outside-thread', outside);
    thread.turns = [{ id: 'outside-turn', threadId: thread.id, status: 'running', items: [] }];
    context.codex.threads.set(thread.id, thread);
    const overview: ServerMessage[] = [];
    const unsubscribe = context.service.subscribeOverview((message) => overview.push(message));
    const before = context.service.events.cursor();
    context.codex.emit({
      type: 'autoReview',
      threadId: thread.id,
      turnId: 'outside-turn',
      review: review({ rationale: '仅供其他项目查看的审核原因。' }),
    });
    context.codex.emit({ type: 'thread', thread });
    context.codex.emit({ type: 'turn', threadId: thread.id, turn: thread.turns[0]! });

    expect(context.service.projection.get(thread.id)).toBeUndefined();
    expect(context.service.events.cursor()).toEqual(before);
    expect(overview).toEqual([]);
    expect((await context.service.listThreads('project')).data).toEqual([]);
    await expect(context.service.getThread(thread.id)).rejects.toMatchObject({
      code: 'PROJECT_OWNERSHIP',
    });
    await expect(context.service.subscribe(thread.id, undefined, () => {})).rejects.toMatchObject({
      code: 'PROJECT_OWNERSHIP',
    });
    expect(context.codex.replies).toBe(0);
    unsubscribe();
  });

  it('preserves observed review results when getThread refreshes a completed upstream history without them', async () => {
    const context = setup();
    const { threadId, turnId } = await start(context);
    const completed = review({
      status: 'denied',
      rationale: '拒绝结果只通过通知发送。',
      completedAtMs: 1_800_000_000_500,
    });
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: completed });
    const upstream = context.codex.threads.get(threadId)!;
    upstream.status = 'completed';
    upstream.turns[0]!.status = 'completed';
    expect(reviews(upstream)).toEqual([]);
    const read = vi.spyOn(context.codex, 'readThread');

    const refreshed = await context.service.getThread(threadId);
    expect(read).toHaveBeenCalledWith(threadId);
    expect(refreshed.status).toBe('completed');
    expect(reviews(refreshed)).toEqual([completed]);
    expect(context.store.activeForThread(threadId)).toBeUndefined();
    const snapshots: ServerMessage[] = [];
    const unsubscribe = await context.service.subscribe(threadId, undefined, (message) =>
      snapshots.push(message),
    );
    expect(snapshots[0]).toMatchObject({ type: 'snapshot', data: refreshed });
    expect(context.codex.replies).toBe(0);
    unsubscribe();
  });

  it('marks unfinished reviews unknown when the runtime disappears while retaining completed decisions', async () => {
    const context = setup();
    const { threadId, turnId } = await start(context);
    const approved = review({
      reviewId: 'completed-review',
      status: 'approved',
      completedAtMs: 1_800_000_000_500,
    });
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: approved });
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: review() });
    context.codex.ready = false;
    context.codex.emit({ type: 'runtime', diagnostics: context.codex.diagnostics() });

    const disconnected = await context.service.getThread(threadId);
    expect(disconnected.status).toBe('unknown');
    expect(disconnected.turns[0]!.status).toBe('unknown');
    expect(reviews(disconnected)).toEqual([approved, review({ status: 'unknown' })]);
    expect(disconnected.actions).toEqual([]);
    expect(context.codex.replies).toBe(0);
  });

  it('marks an unfinished review unknown when its turn ends without an automatic review result', async () => {
    const context = setup();
    const { threadId, turnId } = await start(context);
    context.codex.emit({ type: 'autoReview', threadId, turnId, review: review() });
    context.codex.emit({
      type: 'turn',
      threadId,
      turn: { id: turnId, threadId, status: 'failed', error: '执行进程提前结束', items: [] },
    });

    const ended = await context.service.getThread(threadId);
    expect(ended.status).toBe('failed');
    expect(ended.turns[0]!.status).toBe('failed');
    expect(reviews(ended)).toEqual([review({ status: 'unknown' })]);
    expect(ended.actions).toEqual([]);
    expect(context.store.activeForThread(threadId)).toBeUndefined();
    expect(context.codex.replies).toBe(0);
  });
});

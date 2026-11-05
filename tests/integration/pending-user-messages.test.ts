import { afterEach, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { GatewayService } from '../../src/server/service.js';
import { AppError } from '../../src/shared/errors.js';
import { submittedUserMessage } from '../../src/shared/user-message.js';
import type { TurnView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';
import { captureLogger } from '../fixtures/logging.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const ctx of resources.splice(0)) {
    await ctx.service.shutdown();
    ctx.close();
  }
});
async function setup() {
  const logs = captureLogger();
  const ctx = harness(logs.logger);
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const gate = deferred<TurnView>();
  const entered = deferred<void>();
  const turn: TurnView = { id: 'precompact', threadId: id, status: 'running', items: [] };
  const start = vi.spyOn(ctx.codex, 'startTurn').mockImplementation(async () => {
    const history = ctx.codex.threads.get(id)!;
    history.status = 'running';
    history.turns.push(turn);
    ctx.codex.emit({ type: 'turn', threadId: id, turn: structuredClone(turn) });
    ctx.codex.emit({
      type: 'item',
      threadId: id,
      turnId: turn.id,
      item: { id: 'compact', type: 'contextCompaction', status: 'inProgress' },
    });
    entered.resolve();
    return gate.promise;
  });
  const input = {
    clientOperationId: operationId(),
    text: '继续分析',
    images: ['data:image/png;base64,iVBORw0KGgo='],
  };
  const send = () => ctx.service.startTurn(id, input);
  const echo = (clientId = input.clientOperationId, turnId = turn.id) => {
    const item = { ...submittedUserMessage(clientId, input), id: `native-${clientId}` };
    turn.items.push(item);
    ctx.codex.emit({ type: 'item', threadId: id, turnId, item });
  };
  return { ...ctx, id, gate, entered, turn, start, input, send, echo, logs };
}

it.each([true, false])(
  'keeps the prompt through pre-turn compaction; echo before receipt: %s',
  async (echoFirst) => {
    const ctx = await setup();
    const sending = ctx.send();
    await ctx.entered.promise;
    const view = await ctx.service.getThread(ctx.id);
    expect(view.turns[0]!.items.map((i) => i.type)).toEqual(['contextCompaction']);
    expect(view.pendingMessages).toMatchObject([
      {
        id: ctx.input.clientOperationId,
        turnId: ctx.turn.id,
        status: 'submitting',
        item: { text: ctx.input.text, images: ctx.input.images },
      },
    ]);
    expect(ctx.start).toHaveBeenCalledWith(
      ctx.id,
      realpathSync(ctx.project),
      ctx.input.text,
      undefined,
      ctx.input.images,
      undefined,
      ctx.input.clientOperationId,
    );
    if (echoFirst) ctx.echo();
    ctx.gate.resolve({ ...ctx.turn, items: [] });
    expect((await sending).status).toBe('acknowledged');
    expect((await ctx.service.getThread(ctx.id)).pendingMessages?.[0]?.status).toBe(
      echoFirst ? undefined : 'submitted',
    );
    if (!echoFirst) ctx.echo();
    ctx.echo(); // A duplicate native notification cannot recreate the submission.
    const confirmed = await ctx.service.getThread(ctx.id);
    expect(confirmed.pendingMessages).toBeUndefined();
    expect(confirmed.turns[0]!.items.filter((i) => i.type === 'userMessage')).toHaveLength(1);
    expect(ctx.store.pendingMessages(ctx.id)).toEqual([]);
    expect(ctx.store.get(ctx.input.clientOperationId)).not.toHaveProperty('text');
    const messages = ctx.logs.records.filter(
      (record) =>
        record.operationId === ctx.input.clientOperationId &&
        String(record.event).startsWith('user_message.'),
    );
    expect(messages.map((record) => record.event)).toEqual(
      echoFirst
        ? ['user_message.pending', 'user_message.confirmed']
        : ['user_message.pending', 'user_message.submitted', 'user_message.confirmed'],
    );
    expect(messages).toEqual(messages.map(() => expect.objectContaining({ threadId: ctx.id })));
    expect(messages.at(-1)).toMatchObject({ turnId: ctx.turn.id });
    expect(JSON.stringify(ctx.logs.records)).not.toContain(ctx.input.text);
    expect(JSON.stringify(ctx.logs.records)).not.toContain(ctx.input.images[0]);
  },
);

it('does not confirm by text, an unrelated ID, or a different turn', async () => {
  const ctx = await setup();
  const sending = ctx.send();
  await ctx.entered.promise;
  ctx.echo(operationId());
  ctx.echo(ctx.input.clientOperationId, 'another-turn');
  expect((await ctx.service.getThread(ctx.id)).pendingMessages).toHaveLength(1);
  ctx.gate.resolve({ ...ctx.turn, items: [] });
  await sending;
  const other = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const otherId = (other.result as { threadId: string }).threadId;
  ctx.store.confirmMessage(
    otherId,
    ctx.turn.id,
    submittedUserMessage(ctx.input.clientOperationId, ctx.input),
  );
  expect(ctx.store.pendingMessages(ctx.id)).toHaveLength(1);
  ctx.echo();
  expect((await ctx.service.getThread(ctx.id)).pendingMessages).toBeUndefined();
});

it('recovers persisted content and attachments as unknown without replaying a submission', async () => {
  const ctx = await setup();
  const sending = ctx.send();
  await ctx.entered.promise;
  ctx.gate.resolve({ ...ctx.turn, items: [] });
  await sending;
  await ctx.service.shutdown();
  ctx.codex.ready = true;
  ctx.codex.epoch = 'replacement';
  const restored = new GatewayService({
    store: ctx.store,
    codex: ctx.codex,
    projects: ctx.projects,
  });
  try {
    const view = await restored.getThread(ctx.id);
    expect(view.pendingMessages).toMatchObject([
      { status: 'unknown', item: { text: ctx.input.text, images: ctx.input.images } },
    ]);
    expect(ctx.start).toHaveBeenCalledTimes(1);
    expect(ctx.logs.records.filter((record) => record.event === 'user_message.unknown')).toEqual([
      expect.objectContaining({
        operationId: ctx.input.clientOperationId,
        threadId: ctx.id,
        state: 'unknown',
        reason: 'runtime_recovery',
        level: 40,
      }),
    ]);
    ctx.echo();
    expect((await restored.getThread(ctx.id)).pendingMessages).toBeUndefined();
  } finally {
    await restored.shutdown();
  }
});

it.each([false, true])(
  'retains a rejection across recovery until native confirmation; uncertain=%s',
  async (uncertain) => {
    const ctx = await setup();
    const sending = ctx.send();
    const rejected = expect(sending).rejects.toMatchObject({
      code: uncertain ? 'RESULT_UNKNOWN' : 'CODEX_REQUEST_FAILED',
    });
    await ctx.entered.promise;
    ctx.gate.reject(
      Object.assign(new AppError('CODEX_REQUEST_FAILED', 'PRIVATE_REJECTION', 400), { uncertain }),
    );
    await rejected;
    expect((await ctx.service.getThread(ctx.id)).pendingMessages?.[0]?.status).toBe(
      uncertain ? 'unknown' : 'failed',
    );
    ctx.store.recover();
    expect(ctx.store.pendingMessages(ctx.id)[0]?.status).toBe(uncertain ? 'unknown' : 'failed');
    expect(
      ctx.logs.records.filter(
        (record) =>
          record.event === 'user_message.failed' || record.event === 'user_message.unknown',
      ),
    ).toEqual([
      expect.objectContaining({
        operationId: ctx.input.clientOperationId,
        threadId: ctx.id,
        event: uncertain ? 'user_message.unknown' : 'user_message.failed',
        errorCode: uncertain ? 'RESULT_UNKNOWN' : 'CODEX_REQUEST_FAILED',
        uncertain,
        level: 40,
      }),
    ]);
    expect(JSON.stringify(ctx.logs.records)).not.toContain('PRIVATE_REJECTION');
    ctx.echo();
    expect((await ctx.service.getThread(ctx.id)).pendingMessages).toBeUndefined();
  },
);

it('persists steering with its exact turn and never creates a prompt for empty capacity continuations', async () => {
  const ctx = await setup();
  const sending = ctx.send();
  await ctx.entered.promise;
  ctx.gate.resolve({ ...ctx.turn, items: [] });
  await sending;
  ctx.echo();
  const input = {
    clientOperationId: operationId(),
    expectedTurnId: ctx.turn.id,
    text: '追加要求',
    images: ctx.input.images,
  };
  const steer = vi.spyOn(ctx.codex, 'steerTurn');
  await ctx.service.steer(ctx.id, input);
  expect(steer).toHaveBeenCalledWith(
    ctx.id,
    ctx.turn.id,
    input.text,
    input.images,
    input.clientOperationId,
  );
  expect((await ctx.service.getThread(ctx.id)).pendingMessages).toMatchObject([
    { id: input.clientOperationId, turnId: ctx.turn.id, status: 'submitted' },
  ]);
  ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: { ...ctx.turn, status: 'interrupted' } });
  expect((await ctx.service.getThread(ctx.id)).pendingMessages?.[0]?.status).toBe('unknown');
  ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: { ...ctx.turn, status: 'interrupted' } });
  expect(ctx.logs.records.filter((record) => record.event === 'user_message.unknown')).toEqual([
    expect.objectContaining({
      operationId: input.clientOperationId,
      reason: 'turn_finished',
      turnId: ctx.turn.id,
    }),
  ]);
  const emptyId = operationId();
  await ctx.service.startTurn(ctx.id, { clientOperationId: emptyId, text: '' });
  expect(ctx.store.pendingMessages(ctx.id).some((message) => message.id === emptyId)).toBe(false);
});

it('keeps submitted media when the live native receipt omits it', async () => {
  const ctx = await setup();
  const sending = ctx.send();
  await ctx.entered.promise;
  ctx.gate.resolve({ ...ctx.turn, items: [] });
  await sending;
  const item = {
    id: 'native-media',
    type: 'userMessage',
    clientId: ctx.input.clientOperationId,
    text: ctx.input.text,
  };
  ctx.codex.emit({ type: 'item', threadId: ctx.id, turnId: ctx.turn.id, item });
  ctx.codex.emit({ type: 'item', threadId: ctx.id, turnId: ctx.turn.id, item });
  const view = await ctx.service.getThread(ctx.id);
  expect(view.pendingMessages).toBeUndefined();
  expect(view.turns[0]!.items.find((i) => i.id === item.id)).toMatchObject({
    images: ctx.input.images,
    imageCount: 1,
  });
});

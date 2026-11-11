import { afterEach, expect, it } from 'vitest';
import { captureLogger } from '../fixtures/logging.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const ctx of resources.splice(0)) {
    await ctx.service.shutdown();
    ctx.close();
  }
});

async function lostReceipt() {
  const logs = captureLogger();
  const ctx = harness(logs.logger);
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const operation = operationId();
  ctx.codex.startGate = deferred();
  const sent = ctx.service.startTurn(id, { clientOperationId: operation, text: 'PRIVATE-PROMPT' });
  // Simulate losing both the receipt and the in-memory event-to-operation binding.
  await Promise.resolve();
  ctx.codex.startGate.reject(Object.assign(new Error('timeout'), { uncertain: true }));
  await expect(sent).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  ctx.db.database.run('UPDATE execution_markers SET turn_id = NULL');
  const actual = ctx.codex.threads.get(id)!;
  return { ...ctx, logs, id, operation, actual };
}

it.each(['completed', 'failed', 'interrupted'] as const)(
  'recovers a missing turn ID from an exact native message identity and %s history',
  async (status) => {
    const ctx = await lostReceipt();
    ctx.actual.status = 'idle';
    ctx.actual.turns[0]!.status = status;
    await ctx.service.getThread(ctx.id);
    expect(ctx.service.getOperation(ctx.operation)).toMatchObject({
      status: 'unknown',
      execution: { ended: true, turnId: 'turn-1' },
    });
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    expect(ctx.codex.starts).toBe(1);
    expect(ctx.logs.records).toContainEqual(
      expect.objectContaining({
        event: 'execution.recovered',
        operationId: ctx.operation,
        threadId: ctx.id,
        turnId: 'turn-1',
        reason: 'native_message_identity',
      }),
    );
    expect(JSON.stringify(ctx.logs.records)).not.toContain('PRIVATE-PROMPT');
    await ctx.service.getThread(ctx.id);
    expect(ctx.logs.records.filter((row) => row.event === 'execution.recovered')).toHaveLength(1);
  },
);

it.each(['missing-id', 'other-id', 'duplicate-id', 'active-turn'])(
  'retains uncertainty when native evidence is insufficient: %s',
  async (reason) => {
    const ctx = await lostReceipt();
    ctx.actual.status = 'idle';
    const turn = ctx.actual.turns[0]!;
    turn.status = 'completed';
    if (reason === 'missing-id') delete turn.items[0]!.clientId;
    if (reason === 'other-id') turn.items[0]!.clientId = 'unrelated';
    if (reason === 'duplicate-id')
      ctx.actual.turns.push({ ...structuredClone(turn), id: 'another-turn' });
    if (reason === 'active-turn')
      ctx.actual.turns.push({
        id: 'other',
        threadId: ctx.id,
        status: 'waitingApproval',
        items: [],
      });
    await ctx.service.getThread(ctx.id);
    expect(ctx.store.activeForThread(ctx.id)).toMatchObject({
      operationId: ctx.operation,
      turnId: null,
    });
    expect(ctx.codex.starts).toBe(1);
    expect(ctx.logs.records.filter((row) => row.event === 'execution.recovered')).toHaveLength(0);
  },
);

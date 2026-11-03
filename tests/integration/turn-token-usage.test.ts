import { afterEach, describe, expect, it } from 'vitest';
import { TurnTokenUsage } from '../../src/codex/turn-token-usage.js';
import { CodexAdapter } from '../../src/codex/adapter.js';
import type { TurnView } from '../../src/shared/types.js';
import { TurnUsageStore } from '../../src/server/db/turn-usage.js';
import { openDatabase } from '../../src/server/db/index.js';
import { databaseHarness } from './domain-db-helpers.js';
import { harness, operationId } from './domain-helpers.js';
import { GatewayService } from '../../src/server/service.js';

describe('per-turn output token collection', () => {
  it('uses cumulative deltas across responses, deduplicates notifications, and isolates turns and threads', () => {
    const usage = new TurnTokenUsage();
    usage.created('a');
    usage.started('a', 'first');
    usage.updated('a', 'first', 400);
    usage.started('a', 'first'); // duplicate start must not reset the baseline
    usage.updated('a', 'first', 400);
    usage.updated('b', 'old', 9000); // resumed thread baseline
    usage.started('b', 'second');
    usage.updated('a', 'first', 1200);
    usage.updated('b', 'second', 9600);
    expect(usage.completed('a', 'first')).toBe(1200);
    expect(usage.completed('a', 'first')).toBeUndefined();
    expect(usage.completed('b', 'second')).toBe(600);
    usage.started('a', 'third');
    usage.updated('a', 'first', 500_000); // delayed history replay
    usage.updated('a', 'third', 1500);
    expect(usage.completed('a', 'third')).toBe(300);
  });

  it('does not infer usage from missing baselines, partial observation, or missing updates', () => {
    const usage = new TurnTokenUsage();
    usage.started('unknown', 'one');
    usage.updated('unknown', 'one', 300);
    expect(usage.completed('unknown', 'one')).toBeUndefined();
    usage.created('fresh');
    usage.started('fresh', 'one');
    expect(usage.completed('fresh', 'one')).toBeUndefined();
    usage.started('fresh', 'two');
    usage.updated('fresh', 'two', 100);
    usage.clear();
    usage.updated('fresh', 'two', 200);
    expect(usage.completed('fresh', 'two')).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'invalidates a turn with invalid counters: %s',
    (total) => {
      const usage = new TurnTokenUsage();
      usage.created('a');
      usage.started('a', 'one');
      usage.updated('a', 'one', total as number);
      usage.updated('a', 'one', 800);
      expect(usage.completed('a', 'one')).toBeUndefined();
    },
  );

  it('omits compaction/reset turns and recovers for the following complete turn', () => {
    const usage = new TurnTokenUsage();
    usage.updated('a', 'old', 500);
    usage.started('a', 'one');
    usage.updated('a', 'one', 600);
    usage.updated('a', 'one', 100);
    usage.updated('a', 'one', 900);
    expect(usage.completed('a', 'one')).toBeUndefined();
    usage.started('a', 'two');
    usage.compacted('a', 'two');
    usage.updated('a', 'two', 1100);
    expect(usage.completed('a', 'two')).toBeUndefined();
    usage.started('a', 'three');
    usage.updated('a', 'three', 1300);
    expect(usage.completed('a', 'three')).toBe(200);
  });

  it('maps protocol usage into the completion, without adding reasoning tokens twice or using last-response usage', () => {
    const adapter = new CodexAdapter({ binary: process.execPath });
    const turns: TurnView[] = [];
    adapter.onEvent((event) => {
      if (event.type === 'turn') turns.push(event.turn);
    });
    const notify = (method: string, params: unknown) => adapter['notification']({ method, params });
    const update = (turnId: string, outputTokens: number) =>
      notify('thread/tokenUsage/updated', {
        threadId: 'a',
        turnId,
        tokenUsage: {
          total: { totalTokens: outputTokens * 10, outputTokens, reasoningOutputTokens: 100 },
          last: { outputTokens: 20 },
        },
      });
    update('old', 1000);
    const turn = { id: 'one', status: 'inProgress', items: [], error: null };
    notify('turn/started', { threadId: 'a', turn });
    update('one', 1400);
    update('one', 1600);
    notify('turn/completed', {
      threadId: 'a',
      turn: { ...turn, status: 'completed', durationMs: 20_000 },
    });
    expect(turns.at(-1)).toMatchObject({
      outputTokens: 600,
      totalTokens: 6000,
      durationMs: 20_000,
    });
    notify('turn/completed', { threadId: 'a', turn: { ...turn, status: 'completed' } });
    expect(turns.at(-1)?.outputTokens).toBeUndefined();
  });
});

describe('persisted turn usage', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups
      .splice(0)
      .reverse()
      .forEach((close) => close());
  });

  it('saves the terminal event and hydrates upstream history after a gateway restart', async () => {
    const ctx = harness();
    cleanups.push(ctx.close);
    const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
    const id = (created.result as { threadId: string }).threadId;
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'usage' });
    const turn = ctx.codex.threads.get(id)!.turns[0]!;
    turn.outputTokens = 1200;
    turn.totalTokens = 12600;
    ctx.codex.complete(id, turn.id);
    expect((await ctx.service.getThread(id)).turns[0]?.outputTokens).toBe(1200);
    // The upstream history has timing, but no per-turn usage field.
    delete turn.outputTokens;
    delete turn.totalTokens;
    await ctx.service.shutdown();
    ctx.codex.ready = true;
    const restarted = new GatewayService({
      store: ctx.store,
      codex: ctx.codex,
      projects: ctx.projects,
    });
    expect((await restarted.getThread(id)).turns[0]).toMatchObject({
      outputTokens: 1200,
      totalTokens: 12600,
    });
    await restarted.shutdown();
  });

  it('restores totals after opening a new database connection and isolates identical turn IDs across threads', () => {
    const db = databaseHarness();
    cleanups.push(db.close);
    const store = new TurnUsageStore(db.db.database);
    const turn: TurnView = {
      id: 'one',
      threadId: 'a',
      status: 'completed',
      items: [],
      outputTokens: 1200,
      totalTokens: 12600,
    };
    store.save('a', turn);
    store.save('a', { ...turn, outputTokens: undefined });
    store.save('b', { ...turn, outputTokens: 300 });
    const reopened = openDatabase(db.filename);
    cleanups.push(reopened.close);
    const restored = new TurnUsageStore(reopened.database);
    const history = [{ ...turn, outputTokens: undefined }];
    expect(restored.restore('a', history)[0]).toMatchObject({
      outputTokens: 1200,
      totalTokens: 12600,
    });
    expect(restored.restore('b', history)[0]?.outputTokens).toBe(300);
    expect(restored.restore('unknown', history)[0]?.outputTokens).toBeUndefined();
  });
  it('persists total tokens independently of output counts and preserves unknown vs zero in old history', () => {
    const db = databaseHarness();
    cleanups.push(db.close);
    const store = new TurnUsageStore(db.db.database);
    const turn: TurnView = { id: 'one', threadId: 'a', status: 'completed', items: [] };
    store.save('a', { ...turn, totalTokens: 0 });
    store.save('b', { ...turn, outputTokens: 200 });
    expect(store.restore('a', [turn])[0]).toMatchObject({ totalTokens: 0 });
    expect(store.restore('a', [turn])[0]?.outputTokens).toBeUndefined();
    expect(store.restore('b', [turn])[0]?.totalTokens).toBeUndefined();
    expect(store.restore('b', [turn])[0]?.outputTokens).toBe(200);
  });
});

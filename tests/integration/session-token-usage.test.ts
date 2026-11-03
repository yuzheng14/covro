import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { mapSessionTokenUsage } from '../../src/codex/session-token-usage.js';
import { Projection } from '../../src/server/projection.js';
import { contextUsagePercent } from '../../src/web/lib/context-usage.js';
import { harness, operationId, threadView } from './domain-helpers.js';
import { GatewayService } from '../../src/server/service.js';
import type { CodexEvent } from '../../src/codex/types.js';

const report = (turnId = 'one') =>
  mapSessionTokenUsage(
    {
      total: { totalTokens: 500_000, inputTokens: 480_000, outputTokens: 20_000 },
      last: {
        totalTokens: 50_000,
        inputTokens: 48_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 1000,
      },
      modelContextWindow: 200_000,
    },
    turnId,
  );

describe('session token usage', () => {
  it('maps native notifications without changing per-turn collection', () => {
    const adapter = new CodexAdapter({ binary: process.execPath });
    const events: CodexEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter['notification']({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'a',
        turnId: 'one',
        tokenUsage: report(),
      },
    });
    expect(events).toContainEqual({
      type: 'tokenUsage',
      threadId: 'a',
      usage: expect.objectContaining({
        total: report().total,
        last: report().last,
        modelContextWindow: 200_000,
        turnId: 'one',
      }),
    });
    expect(contextUsagePercent(report())).toBe(25);
  });

  it('distinguishes zero, absent, null and partial/invalid data without inventing totals', () => {
    expect(
      contextUsagePercent(
        mapSessionTokenUsage({ last: { totalTokens: 0 }, modelContextWindow: 100 }, 'a'),
      ),
    ).toBe(0);
    for (const raw of [
      undefined,
      {},
      { total: { totalTokens: 100 } },
      { last: { totalTokens: 100 }, modelContextWindow: null },
      { last: { totalTokens: 100 }, modelContextWindow: 0 },
      { last: { totalTokens: -1 }, modelContextWindow: 100 },
      { last: { inputTokens: 10 }, modelContextWindow: 100 },
    ])
      expect(contextUsagePercent(mapSessionTokenUsage(raw, 'a'))).toBeUndefined();
    const partial = mapSessionTokenUsage(
      {
        last: { totalTokens: NaN, inputTokens: 0, outputTokens: 1.5, secret: 'secret' },
        modelContextWindow: null,
      },
      'a',
    );
    expect(partial.last).toEqual({ inputTokens: 0 });
    expect(partial.modelContextWindow).toBeNull();
    expect(mapSessionTokenUsage({}, 'a').modelContextWindow).toBeUndefined();
  });

  it('preserves exact overflow ratios and suppresses invalidated or stale ratios', () => {
    expect(contextUsagePercent({ ...report(), modelContextWindow: 10_000 })).toBe(500);
    expect(contextUsagePercent({ ...report(), stale: true })).toBeUndefined();
    expect(contextUsagePercent({ ...report(), invalidated: 'compaction' })).toBeUndefined();
  });

  it('isolates threads, ignores old-turn replay, and keeps last usage across new turns and reads', () => {
    const projection = new Projection();
    projection.thread(threadView('a', '/a'));
    projection.thread(threadView('b', '/b'));
    projection.turn('a', { id: 'one', threadId: 'a', status: 'completed', items: [] });
    projection.tokenUsage('a', report());
    projection.thread(threadView('a', '/a'), true);
    projection.turn('a', { id: 'two', threadId: 'a', status: 'running', items: [] });
    projection.tokenUsage('a', { ...report(), last: { totalTokens: 99 } });
    expect(projection.get('a')?.tokenUsage?.last?.totalTokens).toBe(50_000);
    expect(projection.get('b')?.tokenUsage).toBeUndefined();
    projection.item('a', 'two', { id: 'compact', type: 'contextCompaction', status: 'inProgress' });
    expect(contextUsagePercent(projection.get('a')?.tokenUsage)).toBeUndefined();
    projection.tokenUsage('a', report('two'));
    expect(contextUsagePercent(projection.get('a')?.tokenUsage)).toBe(25);
    projection.runtimeReset();
    expect(projection.get('a')?.tokenUsage?.stale).toBe(true);
    expect(new Projection().get('a')?.tokenUsage).toBeUndefined();
  });
});

const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
it('publishes usage through gateway snapshots, preserves browser refresh, and invalidates actual model changes', async () => {
  const ctx = harness();
  closes.push(ctx.close);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  ctx.codex.emit({ type: 'tokenUsage', threadId: id, usage: report() });
  expect((await ctx.service.getThread(id)).tokenUsage?.last?.totalTokens).toBe(50_000);
  ctx.codex.emit({
    type: 'threadSettings',
    threadId: id,
    settings: { model: 'other', reasoningEffort: 'high' },
  });
  expect((await ctx.service.getThread(id)).tokenUsage?.invalidated).toBe('modelChanged');
  ctx.codex.emit({ type: 'tokenUsage', threadId: id, usage: report() });
  expect((await ctx.service.getThread(id)).tokenUsage?.model).toBe('other');
  ctx.codex.emit({ type: 'runtime', diagnostics: { ...ctx.codex.diagnostics(), ready: false } });
  expect((await ctx.service.getThread(id)).tokenUsage?.stale).toBe(true);
  await ctx.service.shutdown();
  ctx.codex.ready = true;
  const restarted = new GatewayService({
    store: ctx.store,
    codex: ctx.codex,
    projects: ctx.projects,
  });
  expect((await restarted.getThread(id)).tokenUsage).toBeUndefined();
  await restarted.shutdown();
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter';
import { updateLiveSettingsSchema } from '../../src/shared/validation';
import { harness, operationId, deferred } from './domain-helpers';
import type { LiveSettingsState } from '../../src/shared/types';
import type { SimulatorOptions } from '../fixtures/app-server';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
});
async function adapterFixture(options: SimulatorOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'live-settings-'));
  const logPath = join(dir, 'rpc.jsonl');
  const adapter = new CodexAdapter({
    binary: resolve('tests/fixtures/codex.mjs'),
    args: ['--options', JSON.stringify({ ...options, logPath })],
  });
  resources.push(async () => {
    await adapter.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await adapter.start();
  const thread = await adapter.createThread(dir, { permissionMode: 'ask' });
  const turn = await adapter.startTurn(thread.id, dir, '[approval]');
  return {
    adapter,
    thread,
    turn,
    dir,
    requests: async () =>
      (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}
it('publishes only the live RPC subset and keeps pending human approval and future settings untouched', async () => {
  const { adapter, thread, turn, dir, requests } = await adapterFixture();
  expect(thread.runtimeSettings?.liveSettingsCapabilities).toEqual({ fast: true, reviewer: true });
  expect(
    await adapter.updateLiveSettings(thread.id, dir, turn.id, {
      serviceTier: 'fast',
      permissionMode: 'auto-review',
    }),
  ).toEqual({ serviceTier: 'fast', approvalReviewer: 'auto_review' });
  expect(
    await adapter.updateLiveSettings(thread.id, dir, turn.id, { permissionMode: 'full-access' }),
  ).toEqual({});
  const calls = await requests();
  expect(calls.filter((entry) => entry.method === 'turn/settings/update')).toEqual([
    expect.objectContaining({
      params: {
        threadId: thread.id,
        turnId: turn.id,
        serviceTier: 'fast',
        approvalsReviewer: 'auto_review',
      },
    }),
  ]);
  expect(calls.some((entry) => entry.method === 'thread/settings/update')).toBe(false);
  expect(calls.some((entry) => !entry.method && entry.result?.decision)).toBe(false);
  expect(
    (await adapter.readThread(thread.id)).runtimeSettings?.model ?? thread.runtimeSettings?.model,
  ).toBe('simulated-model');
});
it('requires the feature for Fast but can publish only a reviewer without it', async () => {
  const { adapter, thread, turn, dir } = await adapterFixture({ stepModelSwitching: false });
  expect(thread.runtimeSettings?.liveSettingsCapabilities).toEqual({ fast: false, reviewer: true });
  await expect(
    adapter.updateLiveSettings(thread.id, dir, turn.id, { serviceTier: 'fast' }),
  ).rejects.toMatchObject({ code: 'LIVE_SETTINGS_UNAVAILABLE' });
  expect(
    await adapter.updateLiveSettings(thread.id, dir, turn.id, { permissionMode: 'auto-review' }),
  ).toEqual({ approvalReviewer: 'auto_review' });
});
it('never treats a rejected or unavailable target as applied', async () => {
  const { adapter, thread, turn, dir } = await adapterFixture({ liveSettingsFailure: true });
  await expect(
    adapter.updateLiveSettings(thread.id, dir, turn.id, { serviceTier: null }),
  ).rejects.toThrow();
  const good = await adapterFixture();
  await expect(
    good.adapter.updateLiveSettings(good.thread.id, good.dir, 'stale-turn', { serviceTier: null }),
  ).rejects.toMatchObject({ code: 'TURN_CONFLICT' });
});
it('rejects model, effort, sandbox and policy fields at the live boundary', () => {
  for (const field of ['model', 'reasoningEffort', 'sandbox', 'approvalPolicy', 'approvalReviewer'])
    expect(
      updateLiveSettingsSchema.safeParse({
        clientOperationId: randomUUID(),
        expectedTurnId: 'turn',
        settings: { [field]: 'arbitrary' },
      }).success,
    ).toBe(false);
});
async function serviceFixture() {
  const ctx = harness();
  resources.push(async () => {
    await ctx.service.shutdown();
    ctx.close();
  });
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const { threadId } = created.result as { threadId: string };
  await ctx.service.startTurn(threadId, { clientOperationId: operationId(), text: 'test' });
  const turnId = ctx.codex.threads.get(threadId)!.turns[0]!.id;
  return { ...ctx, threadId, turnId };
}
it('serializes continuous edits per session, deduplicates operations and clears live claims on completion/reset', async () => {
  const ctx = await serviceFixture();
  const gate = deferred<Partial<Omit<LiveSettingsState, 'turnId'>>>();
  const update = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ serviceTier: null });
  Object.assign(ctx.codex, { updateLiveSettings: update });
  const firstInput = {
    clientOperationId: operationId(),
    expectedTurnId: ctx.turnId,
    settings: { serviceTier: 'fast' as const },
  };
  const first = ctx.service.updateLiveSettings(ctx.threadId, firstInput);
  const second = ctx.service.updateLiveSettings(ctx.threadId, {
    clientOperationId: operationId(),
    expectedTurnId: ctx.turnId,
    settings: { serviceTier: null },
  });
  await expect.poll(() => update.mock.calls.length).toBe(1);
  expect(ctx.service.projection.get(ctx.threadId)?.liveSettings).toBeUndefined();
  gate.resolve({ serviceTier: 'fast' });
  await Promise.all([first, second]);
  expect(ctx.service.projection.get(ctx.threadId)?.liveSettings).toEqual({
    turnId: ctx.turnId,
    serviceTier: null,
  });
  await ctx.service.updateLiveSettings(ctx.threadId, firstInput);
  expect(update).toHaveBeenCalledTimes(2);
  ctx.service.projection.turn(ctx.threadId, {
    ...ctx.codex.threads.get(ctx.threadId)!.turns[0]!,
    status: 'completed',
  });
  expect(ctx.service.projection.get(ctx.threadId)?.liveSettings).toBeUndefined();
  await expect(
    ctx.service.updateLiveSettings(ctx.threadId, {
      clientOperationId: operationId(),
      expectedTurnId: ctx.turnId,
      settings: { serviceTier: 'fast' },
    }),
  ).rejects.toMatchObject({ code: 'TURN_CONFLICT' });
  expect(ctx.codex.interrupts).toBe(0);
});
it('does not publish late receipts onto finished turns or another runtime', async () => {
  const ctx = await serviceFixture();
  const gate = deferred<{ serviceTier: 'fast' }>();
  const update = vi.fn(() => gate.promise);
  Object.assign(ctx.codex, { updateLiveSettings: update });
  const write = ctx.service.updateLiveSettings(ctx.threadId, {
    clientOperationId: operationId(),
    expectedTurnId: ctx.turnId,
    settings: { serviceTier: 'fast' },
  });
  await expect.poll(() => update.mock.calls.length).toBe(1);
  ctx.service.projection.runtimeReset();
  ctx.codex.epoch = 'replacement-runtime';
  gate.resolve({ serviceTier: 'fast' });
  await write;
  expect(ctx.service.projection.get(ctx.threadId)?.liveSettings).toBeUndefined();
});

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../../src/server/config';
import { createApp } from '../../src/server/http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MODEL_CAPACITY_MESSAGE } from '../../src/shared/turn-errors';
import { GatewayService } from '../../src/server/service';
import {
  LOOP_MIN_INTERVAL,
  parseSessionLoop,
  parseSessionLoopCommand,
  type SessionLoop,
} from '../../src/shared/session-loop';
import { captureLogger } from '../fixtures/logging';
import { harness, operationId } from './domain-helpers';

let now = 1_000_000;
const close: (() => void)[] = [];
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fn of close.splice(0)) fn();
});

async function setup(maintenancePending?: () => boolean, logger?: Parameters<typeof harness>[0]) {
  const ctx = harness(logger, { maintenancePending });
  close.push(ctx.close);
  const create = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (create.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, {
    clientOperationId: operationId(),
    text: 'Save the conversation',
  });
  ctx.codex.complete(id, 'turn-1');
  const createLoop = async () => {
    const command = {
      clientOperationId: operationId(),
      intervalMs: LOOP_MIN_INTERVAL,
      prompt: 'Check CI',
    };
    const created = await ctx.service.createSessionLoop(id, command);
    expect(await ctx.service.createSessionLoop(id, command)).toEqual(created);
    return created.result as SessionLoop;
  };
  const createAdaptive = async () => {
    const created = await ctx.service.createSessionLoop(id, {
      clientOperationId: operationId(),
      mode: 'adaptive',
      prompt: 'Check CI and stop when it passes',
    });
    return created.result as SessionLoop;
  };
  return { ...ctx, id, createLoop, createAdaptive };
}

it('parses exact intervals and rejects unsupported durations and missing prompts', () => {
  expect(parseSessionLoop('7m Check CI\nSummarize changes')).toEqual({
    intervalMs: 7 * LOOP_MIN_INTERVAL,
    prompt: 'Check CI\nSummarize changes',
  });
  expect(parseSessionLoop('90m Check CI')?.intervalMs).toBe(90 * LOOP_MIN_INTERVAL);
  for (const input of ['30s Check CI', '0m Check CI', '2d Check CI', 'Check CI', '5m', '5m   '])
    expect(parseSessionLoop(input)).toBeUndefined();
});

it('gives manual sends priority and coalesces missed ticks into one run', async () => {
  const ctx = await setup();
  await ctx.createLoop();
  now += 3 * LOOP_MIN_INTERVAL;
  await Promise.all([
    ctx.service.tickSessionLoops(),
    ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'Manual send' }),
    ctx.service.tickSessionLoops(),
  ]);
  expect(ctx.codex.starts).toBe(2);
  expect((await ctx.service.listSessionLoops(ctx.id))[0]?.runs).toBe(0);
  ctx.codex.complete(ctx.id, 'turn-2');
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(3);
  expect(ctx.codex.threads.get(ctx.id)?.turns.at(-1)?.items[0]?.text).toBe('Check CI');
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 1,
    lastResult: 'running',
    nextRunAt: now + LOOP_MIN_INTERVAL,
  });
  now += 5 * LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(3);
  ctx.codex.complete(ctx.id, 'turn-3');
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(4);
  ctx.codex.complete(ctx.id, 'turn-4');
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    status: 'active',
    runs: 2,
    lastResult: 'completed',
    lastTurnId: 'turn-4',
  });
});

it('persists controls across restarts and leaves a running turn alone on cancellation', async () => {
  const ctx = await setup();
  const loop = await ctx.createLoop();
  const pause = { clientOperationId: operationId(), action: 'pause' as const, version: 0 };
  await ctx.service.controlSessionLoop(ctx.id, loop.id, pause);
  await ctx.service.controlSessionLoop(ctx.id, loop.id, pause);
  await expect(
    ctx.service.controlSessionLoop(ctx.id, loop.id, {
      clientOperationId: operationId(),
      action: 'resume',
      version: 0,
    }),
  ).rejects.toMatchObject({ code: 'LOOP_CONFLICT' });

  now += 10 * LOOP_MIN_INTERVAL;
  await ctx.service.shutdown();
  ctx.codex.reset();
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  expect((await restarted.listSessionLoops(ctx.id))[0]).toMatchObject({
    status: 'paused',
    version: 1,
  });
  await restarted.controlSessionLoop(ctx.id, loop.id, {
    clientOperationId: operationId(),
    action: 'resume',
    version: 1,
  });
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(1);
  now += LOOP_MIN_INTERVAL;
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(2);
  await restarted.controlSessionLoop(ctx.id, loop.id, {
    clientOperationId: operationId(),
    action: 'cancel',
    version: 2,
  });
  expect(ctx.codex.threads.get(ctx.id)?.turns.at(-1)?.status).toBe('running');
  ctx.codex.complete(ctx.id, 'turn-2');
  now += LOOP_MIN_INTERVAL;
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(2);
  expect((await restarted.listSessionLoops(ctx.id))[0]).toMatchObject({
    status: 'cancelled',
    lastResult: 'completed',
  });
  await restarted.shutdown();
});

it('skips downtime and holds an uncertain dispatch without replaying it', async () => {
  const ctx = await setup();
  const loop = await ctx.createLoop();
  await ctx.service.shutdown();
  ctx.codex.reset();
  now += 5 * LOOP_MIN_INTERVAL;
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(1);
  now += LOOP_MIN_INTERVAL;
  const start = vi
    .spyOn(ctx.codex, 'startTurn')
    .mockRejectedValueOnce(new Error('Lost start receipt'));
  await restarted.tickSessionLoops();
  expect(start).toHaveBeenCalledTimes(1);
  await restarted.tickSessionLoops();
  expect((await restarted.listSessionLoops(ctx.id))[0]).toMatchObject({
    id: loop.id,
    status: 'paused',
    lastResult: 'unknown',
    reason: 'uncertain',
    runs: 1,
  });
  now += 8 * LOOP_MIN_INTERVAL;
  await restarted.tickSessionLoops();
  expect(start).toHaveBeenCalledTimes(1);
  const uncertain = ctx.store.activeForThread(ctx.id)!;
  await restarted.reconcileOperation(uncertain.operationId, {
    clientOperationId: operationId(),
    confirmEnded: true,
  });
  await restarted.tickSessionLoops();
  const checked = (await restarted.listSessionLoops(ctx.id))[0]!;
  expect(checked.lastResult).toBe('reconciled');
  await restarted.controlSessionLoop(ctx.id, loop.id, {
    clientOperationId: operationId(),
    action: 'resume',
    version: checked.version,
  });
  now += LOOP_MIN_INTERVAL;
  await restarted.tickSessionLoops();
  expect(start).toHaveBeenCalledTimes(2);
  await restarted.shutdown();
});

it('counts an automatic capacity retry as the same scheduled run', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const ctx = await setup();
  await ctx.createLoop();
  now += LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  const thread = ctx.codex.threads.get(ctx.id)!;
  const turn = thread.turns.at(-1)!;
  turn.status = 'failed';
  turn.error = MODEL_CAPACITY_MESSAGE;
  turn.errorCode = 'serverOverloaded';
  thread.status = 'failed';
  ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: structuredClone(turn) });
  now += LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ctx.codex.starts).toBe(3);
  expect(thread.turns.at(-1)?.items[0]?.text).toBe('');
  ctx.codex.complete(ctx.id, 'turn-3');
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 1,
    lastResult: 'completed',
    lastTurnId: 'turn-3',
  });
});

it('pauses on archive and waits for a manual resume after unarchiving', async () => {
  const ctx = await setup();
  const loop = await ctx.createLoop();
  await ctx.service.setThreadArchived(ctx.id, { clientOperationId: operationId(), archived: true });
  now += LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    id: loop.id,
    status: 'paused',
    reason: 'archived',
  });
  await ctx.service.setThreadArchived(ctx.id, {
    clientOperationId: operationId(),
    archived: false,
  });
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(1);
  await ctx.service.controlSessionLoop(ctx.id, loop.id, {
    clientOperationId: operationId(),
    action: 'resume',
    version: 1,
  });
  now += LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect(ctx.codex.starts).toBe(2);
});

it('keeps dispatching after more than seven days and a hundred runs', async () => {
  const ctx = await setup();
  await ctx.createLoop();
  now += 8 * 24 * 60 * LOOP_MIN_INTERVAL;
  for (let run = 1; run <= 101; run++) {
    await ctx.service.tickSessionLoops();
    ctx.codex.complete(ctx.id, `turn-${run + 1}`);
    now += LOOP_MIN_INTERVAL;
  }
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    status: 'active',
    runs: 101,
    lastResult: 'completed',
  });
});

it.each(['restart', 'update'] as const)(
  'yields when a %s starts waiting and keeps its schedule',
  async (kind) => {
    let pending = false;
    const ctx = await setup(() => pending);
    const loop = await ctx.createLoop();
    now += LOOP_MIN_INTERVAL;
    const tick = ctx.service.tickSessionLoops();
    pending = true; // The request lands after the scheduler has selected a due task.
    await tick;
    expect(ctx.codex.starts).toBe(1);
    expect(ctx.service.restartBlockers()).toEqual([]);
    expect(ctx.service.prepareUpdate('update', false)).toEqual({ ready: true });

    pending = false;
    await ctx.service.tickSessionLoops();
    expect(ctx.codex.starts).toBe(2);
    pending = true;
    expect(ctx.service.restartBlockers()).toContain('running');
    now += 3 * LOOP_MIN_INTERVAL;
    ctx.codex.complete(ctx.id, 'turn-2');
    await ctx.service.tickSessionLoops();
    expect(ctx.codex.starts).toBe(2);
    if (kind === 'restart') expect(ctx.service.restartBlockers(true)).toEqual([]);
    else expect(ctx.service.prepareUpdate()).toEqual({ ready: true });
    expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
      id: loop.id,
      status: 'active',
      runs: 1,
      lastResult: 'completed',
    });
  },
);

it('keeps a queued loop retry from blocking restart or starting another turn during the wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let pending = false;
  const ctx = await setup(() => pending);
  await ctx.createLoop();
  now += LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  const thread = ctx.codex.threads.get(ctx.id)!;
  const turn = thread.turns.at(-1)!;
  Object.assign(turn, {
    status: 'failed',
    error: MODEL_CAPACITY_MESSAGE,
    errorCode: 'serverOverloaded',
  });
  thread.status = 'failed';
  ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: structuredClone(turn) });
  expect((await ctx.service.getThread(ctx.id)).capacityRetry?.status).toBe('waiting');
  pending = true;
  expect(ctx.service.restartBlockers()).toEqual([]);
  expect(ctx.service.prepareUpdate('update', false)).toEqual({ ready: true });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ctx.codex.starts).toBe(2);
  await ctx.service.tickSessionLoops();
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 1,
    lastResult: 'failed',
  });
});

it('lists persisted loops across scopes without hydrating cold sessions or exposing lost ownership', async () => {
  const ctx = await setup();
  const first = await ctx.createLoop();
  const other = join(ctx.directory, 'other');
  mkdirSync(other);
  const project = ctx.service.addProject({ name: 'Other project', path: other });
  const second = (
    await ctx.service.createThread(project.id, {
      clientOperationId: operationId(),
    })
  ).result as { threadId: string };
  await ctx.service.startTurn(second.threadId, {
    clientOperationId: operationId(),
    text: 'Save history',
  });
  ctx.codex.complete(second.threadId, 'turn-2');
  await ctx.codex.renameThread(second.threadId, 'Cold session');
  const created = await ctx.service.createSessionLoop(second.threadId, {
    clientOperationId: operationId(),
    intervalMs: LOOP_MIN_INTERVAL,
    prompt: 'A different project',
  });
  const loop = created.result as SessionLoop;
  const control = {
    clientOperationId: operationId(),
    action: 'pause',
    version: loop.version,
  } as const;
  await ctx.service.shutdown();
  ctx.codex.reset();

  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  try {
    const coldRead = vi.spyOn(ctx.codex, 'readThreadMetadata');
    const history = vi.spyOn(ctx.codex, 'readThread');
    const resume = vi.spyOn(ctx.codex, 'resumeThread');
    const config = parseConfig({}, join(ctx.directory, 'config.json'));
    const app = createApp({ config, service: restarted, staticDir: ctx.directory });
    const origin = config.publicOrigin[0]!;
    // Selectors supplied by the browser have no authority over the instance snapshot.
    const response = await app.request(
      `${origin}/api/loop-tasks?projectId=foreign&instanceId=foreign`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, projectId: 'project', projectName: '测试项目' }),
        expect.objectContaining({
          id: loop.id,
          projectId: project.id,
          projectName: 'Other project',
          threadTitle: 'Cold session',
        }),
      ]),
    );
    expect(coldRead).toHaveBeenCalledWith(second.threadId);
    expect(history).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(
      (await app.request(`${origin}/api/loop-tasks`, { headers: { host: 'foreign.example' } }))
        .status,
    ).toBe(403);

    await expect(restarted.controlSessionLoop(ctx.id, loop.id, control)).rejects.toMatchObject({
      code: 'LOOP_NOT_FOUND',
    });
    const receipt = await restarted.controlSessionLoop(second.threadId, loop.id, control);
    expect(await restarted.controlSessionLoop(second.threadId, loop.id, control)).toEqual(receipt);
    await expect(
      restarted.controlSessionLoop(second.threadId, loop.id, {
        ...control,
        clientOperationId: operationId(),
      }),
    ).rejects.toMatchObject({ code: 'LOOP_CONFLICT' });
    expect(await restarted.listLoopTasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: loop.id, status: 'paused', version: 1 }),
      ]),
    );

    // A cold session that now points outside its saved project must not expose its loop.
    ctx.codex.threads.get(second.threadId)!.cwd = ctx.project;
    expect((await restarted.listLoopTasks()).map((task) => task.id)).toEqual([first.id]);
    ctx.codex.threads.get(second.threadId)!.cwd = other;
    restarted.removeProject(project.id);
    expect((await restarted.listLoopTasks()).map((task) => task.id)).toEqual([first.id]);
    expect(() => restarted.getOperation(control.clientOperationId)).toThrow();
    await expect(
      restarted.controlSessionLoop(second.threadId, loop.id, control),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  } finally {
    await restarted.shutdown();
  }
});

function finishAdaptive(ctx: Awaited<ReturnType<typeof setup>>, output: string) {
  const turn = ctx.codex.threads.get(ctx.id)!.turns.at(-1)!;
  turn.items.push({ id: 'decision', type: 'agentMessage', phase: 'final_answer', text: output });
  ctx.codex.complete(ctx.id, turn.id);
  return turn;
}

const continueAfter = (delaySeconds: number) =>
  JSON.stringify({
    action: 'continue',
    delaySeconds,
    summary: 'CI is running',
    reason: 'Wait for the remaining checks',
  });
const stopDecision = JSON.stringify({
  action: 'stop',
  delaySeconds: null,
  summary: 'CI passed',
  reason: 'All checks passed',
});

it('parses prompt-only loops while preserving validation of fixed durations', () => {
  expect(parseSessionLoopCommand('Check CI and stop when it passes')).toEqual({
    mode: 'adaptive',
    prompt: 'Check CI and stop when it passes',
  });
  expect(parseSessionLoopCommand('2 checks are pending')).toMatchObject({ mode: 'adaptive' });
  expect(parseSessionLoopCommand('5m Check CI')).toEqual({
    intervalMs: 300_000,
    prompt: 'Check CI',
  });
  for (const malformed of ['', '5m', '0m Check CI', '30s Check CI', '1.5m Check CI'])
    expect(parseSessionLoopCommand(malformed)).toBeUndefined();
});

it('schedules variable delays from completed runs and stops exactly once', async () => {
  const ctx = await setup();
  const start = vi.spyOn(ctx.codex, 'startTurn');
  const loop = await ctx.createAdaptive();
  expect(loop).toMatchObject({ mode: 'adaptive', intervalMs: null, nextRunAt: now });
  await ctx.service.tickSessionLoops();
  expect(start.mock.calls[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ required: ['summary', 'reason', 'action', 'delaySeconds'] }),
    ]),
  );
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 1,
    nextRunAt: null,
    lastResult: 'running',
  });

  for (const delaySeconds of [90, 480]) {
    now += 30_000;
    const turn = finishAdaptive(ctx, continueAfter(delaySeconds));
    await ctx.service.tickSessionLoops();
    const next = now + delaySeconds * 1_000;
    expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
      nextRunAt: next,
      lastDecision: { action: 'continue', delaySeconds, reason: 'Wait for the remaining checks' },
    });
    now = next - 1;
    ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: structuredClone(turn) });
    await ctx.service.tickSessionLoops();
    expect((await ctx.service.listSessionLoops(ctx.id))[0]?.nextRunAt).toBe(next);
    now++;
    await ctx.service.tickSessionLoops();
  }
  finishAdaptive(ctx, stopDecision);
  await ctx.service.tickSessionLoops();
  now += 24 * 60 * LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect(start).toHaveBeenCalledTimes(3);
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 3,
    status: 'completed',
    nextRunAt: null,
    lastDecision: { action: 'stop', summary: 'CI passed' },
  });
});

it.each(['pause', 'cancel', 'resume'] as const)(
  'keeps a late adaptive stop from overriding %s',
  async (action) => {
    const ctx = await setup();
    const loop = await ctx.createAdaptive();
    await ctx.service.tickSessionLoops();
    const control = (action: 'pause' | 'cancel' | 'resume', version: number) =>
      ctx.service.controlSessionLoop(ctx.id, loop.id, {
        clientOperationId: operationId(),
        action,
        version,
      });
    await control(action === 'resume' ? 'pause' : action, 0);
    if (action === 'resume') await control('resume', 1);
    finishAdaptive(ctx, stopDecision);
    await ctx.service.tickSessionLoops();
    expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
      status: action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled',
      lastDecision: null,
      runs: action === 'resume' ? 2 : 1,
    });
  },
);

it.each(['missing', 'malformed', 'short delay', 'long delay', 'failed', 'interrupted'] as const)(
  'pauses an adaptive loop on a %s result',
  async (kind) => {
    const logging = captureLogger();
    const ctx = await setup(undefined, logging.logger);
    await ctx.createAdaptive();
    await ctx.service.tickSessionLoops();
    const turn = ctx.codex.threads.get(ctx.id)!.turns.at(-1)!;
    const status = kind === 'failed' || kind === 'interrupted' ? kind : 'completed';
    if (status !== 'completed') {
      turn.status = status;
      ctx.codex.threads.get(ctx.id)!.status = status;
      ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn: structuredClone(turn) });
    } else if (kind === 'missing') {
      ctx.codex.complete(ctx.id, turn.id);
    } else {
      finishAdaptive(
        ctx,
        kind === 'malformed'
          ? 'Invalid confidential answer'
          : continueAfter(kind === 'short delay' ? 59 : 86_401),
      );
    }
    await ctx.service.tickSessionLoops();
    const reason = status === 'completed' ? 'invalid_decision' : 'run_failed';
    expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({
      status: 'paused',
      reason,
      nextRunAt: null,
      lastResult: status,
    });
    const logged = logging.records.find((entry) => entry.event === 'loop.adaptive_paused');
    expect(logged).toMatchObject({ threadId: ctx.id, turnId: turn.id, outcome: 'paused', reason });
    expect(JSON.stringify(logging.records)).not.toMatch(
      /Invalid confidential answer|Wait for the remaining checks|Check CI/,
    );
  },
);

it('restores one overdue adaptive run after restart and yields to maintenance', async () => {
  let pending = false;
  const ctx = await setup(() => pending);
  await ctx.createAdaptive();
  await ctx.service.tickSessionLoops();
  pending = true;
  finishAdaptive(ctx, continueAfter(60));
  await ctx.service.tickSessionLoops();
  now += 5 * LOOP_MIN_INTERVAL;
  await ctx.service.tickSessionLoops();
  expect(ctx.service.restartBlockers()).toEqual([]);
  expect(ctx.codex.starts).toBe(2);
  await ctx.service.shutdown();
  ctx.codex.reset();
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  await restarted.tickSessionLoops();
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(3);
  expect((await restarted.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 2,
    lastResult: 'running',
    nextRunAt: null,
  });
  await restarted.shutdown();
});

it('waits for an outstanding approval before starting an adaptive loop', async () => {
  const ctx = await setup();
  const loop = await ctx.createAdaptive();
  const approval = {
    actionId: 'approval',
    codexEpoch: ctx.codex.epoch,
    rpcId: 42,
    kind: 'command',
    threadId: ctx.id,
    status: 'pending',
    title: 'Approve command',
    options: [{ id: 'accept', label: 'Allow' }],
  } satisfies import('../../src/shared/types').PendingAction;
  ctx.codex.emit({ type: 'action', action: approval });
  await ctx.service.tickSessionLoops();
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({ id: loop.id, runs: 0 });

  ctx.codex.emit({ type: 'actionResolved', actionId: approval.actionId });
  await ctx.service.tickSessionLoops();
  expect((await ctx.service.listSessionLoops(ctx.id))[0]).toMatchObject({ id: loop.id, runs: 1 });
});

it('recovers an unfinished adaptive run from terminal history without replaying it', async () => {
  const ctx = await setup();
  await ctx.createAdaptive();
  await ctx.service.tickSessionLoops();
  await ctx.service.shutdown();
  finishAdaptive(ctx, continueAfter(300));
  now += 10 * LOOP_MIN_INTERVAL;
  ctx.codex.reset();
  const restarted = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
  });
  await restarted.tickSessionLoops();
  expect(ctx.codex.starts).toBe(2);
  expect((await restarted.listSessionLoops(ctx.id))[0]).toMatchObject({
    runs: 1,
    lastResult: 'completed',
    lastDecision: { action: 'continue', delaySeconds: 300 },
    nextRunAt: now + 300_000,
  });
  await restarted.shutdown();
});

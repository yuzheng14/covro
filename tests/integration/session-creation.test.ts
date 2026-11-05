import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../src/shared/errors.js';
import { CodexError } from '../../src/codex/transport.js';
import { GatewayService } from '../../src/server/service.js';
import type { ServerMessage } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
const setup = () => {
  const ctx = harness();
  resources.push(ctx);
  return ctx;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});

it('creates in the selected registered directory and publishes the required first prompt immediately', async () => {
  const ctx = setup();
  const directory = join(ctx.directory, 'second-project');
  mkdirSync(directory);
  const project = ctx.service.addProject({ path: directory, name: 'Second project' });
  const events: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => events.push(event));
  const create = vi.spyOn(ctx.codex, 'createThread');
  const start = vi.spyOn(ctx.codex, 'startTurn');
  const prompt = '  Keep this prompt\nexactly as written.  ';
  const receipt = await ctx.service.createSession(project.id, {
    clientOperationId: operationId(),
    prompt,
  });
  expect(receipt).toMatchObject({
    status: 'acknowledged',
    result: {
      stage: 'submitted',
      threadId: 'thread-1',
      turnId: 'turn-1',
    },
  });
  expect(create).toHaveBeenCalledWith(project.canonicalRoot, undefined);
  expect(start).toHaveBeenCalledWith(
    'thread-1',
    project.canonicalRoot,
    prompt,
    undefined,
    undefined,
  );
  expect(await ctx.service.getThread('thread-1')).toMatchObject({
    projectId: project.id,
    cwd: project.canonicalRoot,
    managed: true,
    historyVisible: true,
    status: 'running',
  });
  expect((await ctx.service.listThreads(project.id)).data).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'threadSummary',
      payload: expect.objectContaining({ id: 'thread-1', historyVisible: true }),
    }),
  );
});

it.each(['', ' \n\t ', 'x'.repeat(100_001)])(
  'rejects an invalid initial prompt before creating a thread',
  async (prompt) => {
    const ctx = setup();
    await expect(
      ctx.service.createSession('project', { clientOperationId: operationId(), prompt }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(ctx.codex.creates).toBe(0);
    expect(ctx.codex.starts).toBe(0);
  },
);

it('rechecks project availability instead of trusting the prior project list', async () => {
  const ctx = setup();
  expect(ctx.service.listProjects()[0]).toMatchObject({ id: 'project', available: true });
  rmSync(ctx.project, { recursive: true });
  await expect(
    ctx.service.createSession('project', {
      clientOperationId: operationId(),
      prompt: 'Run in this project',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
  expect(ctx.codex.creates).toBe(0);
});

it('deduplicates concurrent and completed calls without waiting for the new turn to finish', async () => {
  const ctx = setup();
  ctx.codex.startGate = deferred();
  const input = { clientOperationId: operationId(), prompt: 'Start this task' };
  const first = ctx.service.createSession('project', input);
  await vi.waitFor(() => expect(ctx.codex.starts).toBe(1));
  const duplicate = await ctx.service.createSession('project', input);
  expect(duplicate).toMatchObject({
    status: 'dispatching',
    result: { threadId: 'thread-1', stage: 'created' },
  });
  expect(ctx.store.pendingProjectOperations('project').map((op) => op.kind)).toContain(
    'session.create',
  );
  ctx.codex.startGate.resolve(ctx.codex.threads.get('thread-1')!.turns[0]!);
  const receipt = await first;
  expect(await ctx.service.createSession('project', input)).toEqual(receipt);
  expect(ctx.codex.creates).toBe(1);
  expect(ctx.codex.starts).toBe(1);
  expect(ctx.store.activeForThread('thread-1')).toBeDefined();
  await expect(
    ctx.service.createSession('project', { ...input, prompt: 'Different task' }),
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
});

it('preserves the created thread when initial prompt submission is definitely rejected', async () => {
  const ctx = setup();
  const start = vi
    .spyOn(ctx.codex, 'startTurn')
    .mockRejectedValue(new AppError('REJECTED', 'Rejected', 400));
  const input = { clientOperationId: operationId(), prompt: 'Rejected task' };
  await expect(ctx.service.createSession('project', input)).rejects.toMatchObject({
    code: 'REJECTED',
  });
  expect(ctx.service.getOperation(input.clientOperationId)).toMatchObject({
    status: 'failed',
    result: { stage: 'created', threadId: 'thread-1' },
    error: { code: 'REJECTED' },
  });
  expect(await ctx.service.createSession('project', input)).toMatchObject({
    status: 'failed',
    result: { threadId: 'thread-1' },
  });
  expect(ctx.codex.creates).toBe(1);
  expect(start).toHaveBeenCalledTimes(1);
});

it('keeps a lost prompt receipt unknown across restart without resending it', async () => {
  const ctx = setup();
  const start = vi
    .spyOn(ctx.codex, 'startTurn')
    .mockRejectedValue(new CodexError('RESULT_UNKNOWN', 'Lost receipt', true));
  const input = { clientOperationId: operationId(), prompt: 'Possibly accepted task' };
  await expect(ctx.service.createSession('project', input)).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  const recovered = new GatewayService(ctx);
  expect(await recovered.createSession('project', input)).toMatchObject({
    status: 'unknown',
    result: { stage: 'created', threadId: 'thread-1' },
  });
  expect(ctx.codex.creates).toBe(1);
  expect(start).toHaveBeenCalledTimes(1);
});

it('does not submit a prompt when thread creation has an unknown outcome', async () => {
  const ctx = setup();
  const create = vi
    .spyOn(ctx.codex, 'createThread')
    .mockRejectedValue(new CodexError('RESULT_UNKNOWN', 'Lost creation receipt', true));
  const input = { clientOperationId: operationId(), prompt: 'Wait for confirmed creation' };
  await expect(ctx.service.createSession('project', input)).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  expect(await ctx.service.createSession('project', input)).toMatchObject({
    status: 'unknown',
    result: { stage: 'creating' },
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(ctx.codex.starts).toBe(0);
});

it('recovers the child creation receipt if the process stopped between creation and prompt submission', async () => {
  const ctx = setup();
  const input = { clientOperationId: operationId(), prompt: 'Interrupted before submission' };
  const steps = {
    creationOperationId: operationId(),
    promptOperationId: operationId(),
    stage: 'creating',
  };
  ctx.store.accept(input.clientOperationId, 'session.create', 'project', input);
  ctx.store.associateProject(input.clientOperationId, 'project');
  ctx.store.dispatch(input.clientOperationId);
  ctx.store.checkpoint(input.clientOperationId, steps);
  await ctx.service.createThread('project', { clientOperationId: steps.creationOperationId });
  const recovered = new GatewayService(ctx);
  expect(await recovered.createSession('project', input)).toMatchObject({
    status: 'unknown',
    result: { threadId: 'thread-1', stage: 'created' },
  });
  expect(ctx.codex.creates).toBe(1);
  expect(ctx.codex.starts).toBe(0);
});

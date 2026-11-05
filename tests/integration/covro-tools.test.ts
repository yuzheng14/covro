import { afterEach, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { CovroTools } from '../../src/server/mcp/tools.js';
import { AppError } from '../../src/shared/errors.js';
import { harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
function setup() {
  const ctx = harness();
  resources.push(ctx);
  return { ...ctx, tools: new CovroTools(ctx.service, 'http://127.0.0.1:8787') };
}

it('lists registered project IDs and canonical paths rather than scanning arbitrary directories', () => {
  const ctx = setup();
  expect(ctx.tools.listProjects({}).structuredContent).toEqual({
    projects: [
      {
        project_id: 'project',
        name: '测试项目',
        path: realpathSync(ctx.project),
        available: true,
      },
    ],
  });
  expect(() => ctx.tools.listProjects({ cwd: '/' })).toThrow();
});

it('creates a managed session with its first prompt and a working existing navigation URL', async () => {
  const ctx = setup();
  const reply = await ctx.tools.createSession(
    { project_id: 'project', prompt: 'Do the task' },
    { threadId: 'parent', callId: 'call-1' },
  );
  expect(reply.isError).toBeUndefined();
  expect(reply.structuredContent).toMatchObject({
    status: 'acknowledged',
    stage: 'submitted',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
  });
  const url = new URL(String(reply.structuredContent.url));
  expect(url.origin).toBe('http://127.0.0.1:8787');
  expect(JSON.parse(decodeURIComponent(url.hash.slice('#notification='.length)))).toEqual({
    threadId: 'thread-1',
    projectId: 'project',
  });
  expect(
    await ctx.tools.createSession(
      { project_id: 'project', prompt: 'Do the task' },
      { threadId: 'parent', callId: 'call-1' },
    ),
  ).toEqual(reply);
  expect(ctx.codex.creates).toBe(1);
  expect(ctx.codex.starts).toBe(1);
});

it('allows explicit retry keys and rejects a changed prompt without returning a misleading success', async () => {
  const ctx = setup();
  const key = operationId();
  const input = { project_id: 'project', prompt: 'Original', request_key: key };
  const reply = await ctx.tools.createSession(input);
  expect(reply.structuredContent.request_key).toBe(key);
  expect(await ctx.tools.createSession(input)).toEqual(reply);
  const conflict = await ctx.tools.createSession({ ...input, prompt: 'Changed' });
  expect(conflict).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'OPERATION_CONFLICT' } },
  });
  expect(ctx.codex.creates).toBe(1);
});

it('requires a retry key for non-Codex callers and rejects missing or blank prompts and arbitrary cwd', async () => {
  const ctx = setup();
  expect(await ctx.tools.createSession({ project_id: 'project', prompt: 'Task' })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'REQUEST_KEY_REQUIRED' } },
  });
  for (const input of [
    { project_id: 'project' },
    { project_id: 'project', prompt: ' \n ' },
    { project_id: 'project', prompt: 'Task', cwd: '/tmp' },
  ])
    await expect(ctx.tools.createSession(input)).rejects.toThrow();
  expect(ctx.codex.creates).toBe(0);
});

it('returns the existing session and an error if its first prompt fails', async () => {
  const ctx = setup();
  vi.spyOn(ctx.codex, 'startTurn').mockRejectedValue(new AppError('REJECTED', 'Not accepted', 400));
  const reply = await ctx.tools.createSession({
    project_id: 'project',
    prompt: 'Task',
    request_key: operationId(),
  });
  expect(reply).toMatchObject({
    isError: true,
    structuredContent: {
      status: 'failed',
      thread_id: 'thread-1',
      stage: 'created',
      error: { code: 'REJECTED' },
    },
  });
  expect(reply.structuredContent.url).toBeDefined();
});

it('does not replace a maintenance error with an old successful receipt', async () => {
  const ctx = setup();
  const input = { project_id: 'project', prompt: 'Task', request_key: operationId() };
  await ctx.tools.createSession(input);
  ctx.service.setMaintenance(true);
  expect(await ctx.tools.createSession(input)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'UPDATE_MAINTENANCE' } },
  });
});

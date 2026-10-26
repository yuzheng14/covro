import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { harness, operationId } from './domain-helpers';
import { PROJECT_INIT_PROMPT } from '../../src/server/project-init';
import { startTurnSchema, steerSchema } from '../../src/shared/validation';
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
async function setup() {
  const ctx = harness();
  cleanup.push(ctx.close);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return { ...ctx, id: (created.result as { threadId: string }).threadId };
}
it('dispatches the server-owned init task once through the normal task lifecycle', async () => {
  const ctx = await setup();
  const start = vi.spyOn(ctx.codex, 'startTurn');
  const payload = { clientOperationId: operationId(), text: '/init', taskKind: 'init' as const };
  const op = await ctx.service.startTurn(ctx.id, payload);
  expect(op.status).toBe('acknowledged');
  expect(start).toHaveBeenCalledWith(
    ctx.id,
    await realpath(ctx.project),
    PROJECT_INIT_PROMPT,
    undefined,
    undefined,
  );
  expect(await ctx.service.startTurn(ctx.id, payload)).toEqual(op);
  expect(start).toHaveBeenCalledTimes(1);
});
it.each(['file', 'directory', 'symlink'])(
  'preserves an existing AGENTS.md %s and never dispatches',
  async (kind) => {
    const ctx = await setup();
    const path = join(ctx.project, 'AGENTS.md');
    if (kind === 'file') await writeFile(path, 'keep existing instructions');
    else if (kind === 'directory') await mkdir(path);
    else await symlink(join(ctx.directory, 'missing'), path);
    const id = operationId();
    await expect(
      ctx.service.startTurn(ctx.id, { clientOperationId: id, text: '/init', taskKind: 'init' }),
    ).rejects.toMatchObject({ code: 'AGENTS_EXISTS' });
    expect(ctx.codex.starts).toBe(0);
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    expect(ctx.service.getOperation(id).status).toBe('failed');
    if (kind === 'file') expect(await readFile(path, 'utf8')).toBe('keep existing instructions');
  },
);
it('keeps escaped/ordinary /init text ordinary and forbids initialization via steer', async () => {
  const ctx = await setup();
  await writeFile(join(ctx.project, 'AGENTS.md'), 'keep');
  const start = vi.spyOn(ctx.codex, 'startTurn');
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: '/init' });
  expect(start.mock.calls[0]![2]).toBe('/init');
  expect(
    startTurnSchema.safeParse({
      clientOperationId: operationId(),
      text: '/init',
      taskKind: 'shell',
    }).success,
  ).toBe(false);
  expect(
    steerSchema.safeParse({
      clientOperationId: operationId(),
      expectedTurnId: 'turn',
      text: '/init',
      taskKind: 'init',
    }).success,
  ).toBe(false);
});

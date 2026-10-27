import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { SkillCatalog } from '../../src/shared/skills.js';
import { GatewayService } from '../../src/server/service.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});
function setup() {
  const ctx = harness();
  resources.push(ctx);
  const listSkills = vi.fn(async (cwd: string): Promise<SkillCatalog> => ({
    cwd,
    skills: ['a', 'b'].map((scope) => ({
      name: 'same',
      path: `${cwd}/${scope}/SKILL.md`,
      scope: 'repo',
      description: '原文',
      enabled: scope === 'a',
      pluginId: null,
    })),
    errors: [{ path: 'broken/SKILL.md', message: 'bad metadata' }],
  }));
  Object.assign(ctx.codex, { listSkills });
  const service = new GatewayService({
    store: ctx.store,
    projects: ctx.projects,
    codex: ctx.codex,
    workspacesRoot: join(ctx.directory, 'workspaces'),
  });
  return { ...ctx, service, listSkills };
}
it('uses server-owned project/session cwd and preserves duplicate names, disabled skills and discovery errors', async () => {
  const ctx = setup();
  const catalog = await ctx.service.listSkills({ projectId: 'project', forceReload: true });
  expect(ctx.listSkills).toHaveBeenLastCalledWith(realpathSync(ctx.project), true);
  expect(catalog.skills).toHaveLength(2);
  expect(catalog.errors).toHaveLength(1);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  expect(await ctx.service.listSkills({ projectId: 'project', threadId })).toEqual(catalog);
  await expect(ctx.service.listSkills({ projectId: null, threadId })).rejects.toMatchObject({
    code: 'PROJECT_OWNERSHIP',
  });
});
it('reserves the exact unassigned first-message cwd and isolates other drafts', async () => {
  const ctx = setup();
  const draftId = operationId();
  const draft = await ctx.service.listSkills({ projectId: null, draftId });
  const other = await ctx.service.listSkills({ projectId: null, draftId: operationId() });
  expect(other.cwd).not.toBe(draft.cwd);
  const created = await ctx.service.createThread(null, { clientOperationId: draftId });
  const threadId = (created.result as { threadId: string }).threadId;
  expect((await ctx.service.listSkills({ projectId: null, threadId })).cwd).toBe(draft.cwd);
  await expect(ctx.service.listSkills({ projectId: null, draftId })).rejects.toThrow();
});
it('rejects offline reads and results from an obsolete Codex epoch or a mismatched cwd', async () => {
  const ctx = setup();
  ctx.codex.ready = false;
  await expect(ctx.service.listSkills({ projectId: 'project' })).rejects.toThrow();
  expect(ctx.listSkills).not.toHaveBeenCalled();
  ctx.codex.ready = true;
  const gate = deferred<SkillCatalog>();
  ctx.listSkills.mockReturnValueOnce(gate.promise);
  const reading = ctx.service.listSkills({ projectId: 'project' });
  ctx.codex.epoch = 'new';
  gate.resolve({ cwd: ctx.project, skills: [], errors: [] });
  await expect(reading).rejects.toMatchObject({ code: 'SKILLS_READ_FAILED' });
  ctx.listSkills.mockResolvedValueOnce({ cwd: '/wrong', skills: [], errors: [] });
  await expect(ctx.service.listSkills({ projectId: 'project' })).rejects.toMatchObject({
    code: 'SKILLS_READ_FAILED',
  });
});

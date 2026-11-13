import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GatewayService } from '../../src/server/service.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { harness, DomainCodex, operationId } from './domain-helpers.js';
import { databaseHarness } from './domain-db-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
it('authorizes canonical session directories and descendants, excludes outside cwd, and revokes provenance on restart', async () => {
  const h = harness();
  cleanups.push(async () => {
    await h.service.shutdown();
    h.close();
  });
  const operation = await h.service.createThread('project', { clientOperationId: operationId() });
  const id = (operation.result as { threadId: string }).threadId;
  const nested = join(h.project, 'client');
  const outside = join(h.directory, 'outside');
  mkdirSync(nested);
  mkdirSync(outside);
  expect(h.service.previewContext(id, nested)).toMatchObject({
    projectId: 'project',
    canonicalCwd: realpathSync(nested),
  });
  expect(h.service.previewContext(id, outside)).toBeUndefined();
  expect(h.service.previewContext(operationId(), h.project)).toBeUndefined();
  symlinkSync(outside, join(h.project, 'alias'));
  expect(h.service.previewContext(id, join(h.project, 'alias'))).toBeUndefined();
  h.codex.reset();
  expect(h.service.previewContext(id, h.project)).toBeUndefined();
});
it('isolates unassigned session workspaces, including symlinks to a sibling session', async () => {
  const db = databaseHarness();
  const codex = new DomainCodex();
  const service = new GatewayService({
    store: db.store,
    codex,
    projects: new ProjectRegistry([]),
    workspacesRoot: join(db.directory, 'workspaces'),
  });
  cleanups.push(async () => {
    await service.shutdown();
    db.close();
  });
  const create = async () => {
    const op = await service.createThread(null, { clientOperationId: operationId() });
    return service.getThread((op.result as { threadId: string }).threadId);
  };
  const first = await create();
  const second = await create();
  const nested = join(first.cwd, 'frontend');
  mkdirSync(nested);
  expect(service.previewContext(first.id, nested)).toMatchObject({
    projectId: null,
    canonicalCwd: realpathSync(nested),
  });
  expect(service.previewContext(first.id, second.cwd)).toBeUndefined();
  symlinkSync(second.cwd, join(first.cwd, 'other'));
  expect(service.previewContext(first.id, join(first.cwd, 'other'))).toBeUndefined();
});

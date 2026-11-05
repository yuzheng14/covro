import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { GatewayService } from '../../src/server/service.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { referenceMessage } from '../../src/server/file-references.js';
import { fileToken } from '../../src/shared/file-references.js';
import { fileSearchQuerySchema, startTurnSchema } from '../../src/shared/validation.js';
import { harness, operationId, deferred } from './domain-helpers';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});
function setup() {
  const ctx = harness();
  resources.push(ctx);
  const cwd = realpathSync(ctx.project);
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs/中文 说明.md'), 'hello');
  const searchFiles = vi.fn(async (root: string) => ({
    files: [
      {
        root,
        path: 'docs/中文 说明.md',
        match_type: 'file' as const,
        file_name: '中文 说明.md',
        score: 1,
        indices: null,
      },
    ],
  }));
  Object.assign(ctx.codex, { searchFiles });
  const service = new GatewayService({
    store: ctx.store,
    codex: ctx.codex,
    projects: ctx.projects,
    workspacesRoot: join(ctx.directory, 'workspaces'),
  });
  return { ...ctx, cwd, searchFiles, service };
}
it('derives roots for registered subdirectories and reserved unassigned drafts/sessions', async () => {
  const ctx = setup();
  const search = (input: object) =>
    ctx.service.searchFiles(
      { projectId: 'project', query: '中文', ...input },
      new AbortController().signal,
    );
  expect((await search({})).paths).toEqual(['docs/中文 说明.md']);
  expect(ctx.searchFiles.mock.calls[0]?.[0]).toBe(ctx.cwd);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  await search({ threadId });
  await expect(search({ projectId: null, threadId })).rejects.toMatchObject({
    code: 'PROJECT_OWNERSHIP',
  });
  const draftId = operationId();
  const draft = await search({ projectId: null, draftId, query: '' });
  writeFileSync(join(draft.cwd, 'first.txt'), 'first');
  const made = await ctx.service.createThread(null, { clientOperationId: draftId });
  const id = (made.result as { threadId: string }).threadId;
  expect((await search({ projectId: null, threadId: id, query: '' })).cwd).toBe(draft.cwd);
  await expect(search({ projectId: null, draftId })).rejects.toThrow();
});
it.each([
  '../outside.txt',
  '/etc/passwd',
  'docs/../../outside.txt',
  'docs\\file',
  'docs/link.md',
  'docs/internal.md',
  'docs/missing.md',
])('blocks invalid, missing and symlink references: %s', async (path) => {
  const ctx = setup();
  writeFileSync(join(ctx.directory, 'outside.txt'), 'private');
  symlinkSync(join(ctx.directory, 'outside.txt'), join(ctx.cwd, 'docs/link.md'));
  symlinkSync(join(ctx.cwd, 'docs/中文 说明.md'), join(ctx.cwd, 'docs/internal.md'));
  const text = fileToken(path);
  await expect(
    referenceMessage(text, [{ path, cwd: ctx.cwd, start: 0, end: text.length }], {
      cwd: ctx.cwd,
      excluded: [],
    }),
  ).rejects.toThrow();
});
it('excludes nested registrations and other managed workspaces even when the upstream returns them', async () => {
  const ctx = setup();
  mkdirSync(join(ctx.cwd, 'nested'));
  writeFileSync(join(ctx.cwd, 'nested/private.txt'), 'private');
  ctx.projects.add({ path: join(ctx.cwd, 'nested') });
  ctx.searchFiles.mockResolvedValueOnce({
    files: [
      {
        root: ctx.cwd,
        path: 'nested/private.txt',
        match_type: 'file',
        file_name: 'private.txt',
        score: 1,
        indices: null,
      },
    ],
  });
  expect(
    (
      await ctx.service.searchFiles(
        { projectId: 'project', query: 'private' },
        new AbortController().signal,
      )
    ).paths,
  ).toEqual([]);
});
it('does not let a project query use a supplied draft id to reveal another allocated workspace', async () => {
  const ctx = setup();
  const service = new GatewayService({
    store: ctx.store,
    codex: ctx.codex,
    projects: ctx.projects,
    workspacesRoot: join(ctx.cwd, 'managed'),
  });
  const draftId = operationId();
  const draft = await service.searchFiles(
    { projectId: null, draftId, query: '' },
    new AbortController().signal,
  );
  writeFileSync(join(draft.cwd, 'private.txt'), 'private');
  ctx.searchFiles.mockResolvedValueOnce({
    files: [
      {
        root: ctx.cwd,
        path: `managed/${draftId}/private.txt`,
        match_type: 'file',
        file_name: 'private.txt',
        score: 1,
        indices: null,
      },
    ],
  });
  const result = await service.searchFiles(
    { projectId: 'project', draftId, query: 'private' },
    new AbortController().signal,
  );
  expect(result.paths).toEqual([]);
});
it('keeps newly available and removed nested registrations outside the parent file boundary', async () => {
  const ctx = setup();
  const nested = join(ctx.cwd, 'late');
  const projects = new ProjectRegistry([
    { id: 'parent', name: 'parent', path: ctx.cwd },
    { id: 'nested', name: 'nested', path: nested },
  ]);
  mkdirSync(nested);
  writeFileSync(join(nested, 'private.txt'), 'private');
  const service = new GatewayService({ store: ctx.store, codex: ctx.codex, projects });
  const files = [
    {
      root: ctx.cwd,
      path: 'late/private.txt',
      match_type: 'file' as const,
      file_name: 'private.txt',
      score: 1,
      indices: null,
    },
  ];
  for (const removed of [false, true]) {
    if (removed) projects.remove('nested');
    ctx.searchFiles.mockResolvedValueOnce({ files });
    expect(
      (
        await service.searchFiles(
          { projectId: 'parent', query: 'private' },
          new AbortController().signal,
        )
      ).paths,
    ).toEqual([]);
  }
});
it('sends native quoted path text and rejects deleted files before dispatch', async () => {
  const ctx = setup();
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const path = 'docs/中文 说明.md';
  const text = 'Read ' + fileToken(path);
  const files = [{ path, cwd: ctx.cwd, start: 5, end: text.length }];
  const start = vi.spyOn(ctx.codex, 'startTurn');
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text, files });
  expect(start.mock.calls[0]?.[2]).toBe('Read "docs/中文 说明.md"');
  ctx.codex.complete(id, 'turn-1');
  unlinkSync(join(ctx.cwd, path));
  await expect(
    ctx.service.startTurn(id, { clientOperationId: operationId(), text, files }),
  ).rejects.toMatchObject({ code: 'FILE_REFERENCE_NOT_FOUND' });
  expect(start).toHaveBeenCalledTimes(1);
});
it('uses the session cwd rather than the project root and prevents sibling-file access', async () => {
  const ctx = setup();
  const native = await ctx.codex.createThread(join(ctx.cwd, 'docs'));
  const cwd = join(ctx.cwd, 'docs');
  ctx.searchFiles.mockResolvedValueOnce({
    files: [
      {
        root: cwd,
        path: '中文 说明.md',
        match_type: 'file',
        file_name: '中文 说明.md',
        score: 1,
        indices: null,
      },
    ],
  });
  const result = await ctx.service.searchFiles(
    { projectId: 'project', threadId: native.id, query: '中文' },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ cwd, paths: ['中文 说明.md'] });
  expect(ctx.searchFiles.mock.calls[0]?.[0]).toBe(cwd);
  const path = '../outside.txt';
  const text = fileToken(path);
  await expect(
    referenceMessage(text, [{ path, cwd, start: 0, end: text.length }], { cwd, excluded: [] }),
  ).rejects.toMatchObject({ code: 'FILE_REFERENCE_OUTSIDE' });
});
it('caps large native result sets, excludes directories, and reports unreadable matches', async () => {
  const ctx = setup();
  const rows = Array.from({ length: 60 }, (_, index) => {
    const path = `large-${index}.txt`;
    writeFileSync(join(ctx.cwd, path), 'file');
    return {
      root: ctx.cwd,
      path,
      match_type: 'file' as const,
      file_name: path,
      score: 1,
      indices: null,
    };
  });
  ctx.searchFiles.mockResolvedValueOnce({ files: rows });
  const result = await ctx.service.searchFiles(
    { projectId: 'project', query: 'large' },
    new AbortController().signal,
  );
  expect(result.paths).toHaveLength(50);
  expect(result.limited).toBe(true);
  chmodSync(join(ctx.cwd, 'docs/中文 说明.md'), 0);
  try {
    await expect(
      ctx.service.searchFiles(
        { projectId: 'project', query: '中文' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_REFERENCE_UNREADABLE' });
  } finally {
    chmodSync(join(ctx.cwd, 'docs/中文 说明.md'), 0o600);
  }
});
it('rejects mismatched cwd/ranges, bounds queries and inputs, and never accepts client roots', async () => {
  const ctx = setup();
  const path = 'docs/中文 说明.md';
  const text = fileToken(path);
  const file = { path, cwd: ctx.cwd, start: 0, end: text.length };
  for (const files of [[{ ...file, cwd: '/other' }], [{ ...file, start: 1 }], [file, file]])
    await expect(
      referenceMessage(text, files, { cwd: ctx.cwd, excluded: [] }),
    ).rejects.toMatchObject({ code: 'FILE_REFERENCE_CHANGED' });
  expect(
    fileSearchQuerySchema.safeParse({ projectId: 'project', query: 'a', cwd: '/other' }).success,
  ).toBe(false);
  expect(
    fileSearchQuerySchema.safeParse({ projectId: 'project', query: 'a'.repeat(513) }).success,
  ).toBe(false);
  expect(
    startTurnSchema.safeParse({
      clientOperationId: operationId(),
      text,
      files: Array(33).fill(file),
    }).success,
  ).toBe(false);
});
it('discards old runtime results, respects cancellation and rejects offline search', async () => {
  const ctx = setup();
  ctx.codex.ready = false;
  await expect(
    ctx.service.searchFiles({ projectId: 'project', query: 'a' }, new AbortController().signal),
  ).rejects.toThrow();
  expect(ctx.searchFiles).not.toHaveBeenCalled();
  ctx.codex.ready = true;
  const gate = deferred<Awaited<ReturnType<typeof ctx.searchFiles>>>();
  ctx.searchFiles.mockReturnValueOnce(gate.promise);
  const pending = ctx.service.searchFiles(
    { projectId: 'project', query: 'a' },
    new AbortController().signal,
  );
  ctx.codex.epoch = 'new';
  gate.resolve({ files: [] });
  await expect(pending).rejects.toMatchObject({ code: 'FILE_REFERENCE_CHANGED' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    ctx.service.searchFiles({ projectId: 'project', query: 'a' }, controller.signal),
  ).rejects.toMatchObject({ code: 'FILE_SEARCH_CANCELLED' });
});

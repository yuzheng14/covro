import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { harness, operationId } from './domain-helpers';
import { readWorkspaceDiff } from '../../src/server/workspace-diff';
const close: (() => void)[] = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
});
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  )
    .toString()
    .trim();
}
async function setup() {
  const ctx = harness();
  close.push(ctx.close);
  git(ctx.project, 'init', '-b', 'main');
  await writeFile(join(ctx.project, 'staged.txt'), 'old staged\n');
  await writeFile(join(ctx.project, 'unstaged.txt'), 'old unstaged\n');
  git(ctx.project, 'add', '.');
  git(ctx.project, 'commit', '-m', 'baseline');
  return ctx;
}
it('separates staged, unstaged and untracked content without creating a model task', async () => {
  const ctx = await setup();
  await writeFile(join(ctx.project, 'staged.txt'), 'new staged\n');
  git(ctx.project, 'add', 'staged.txt');
  await writeFile(join(ctx.project, 'unstaged.txt'), 'new unstaged\n');
  await writeFile(join(ctx.project, 'new 中文 file.txt'), 'new content\n');
  await writeFile(join(ctx.project, 'binary.bin'), Buffer.from([0, 1, 2]));
  const value = await ctx.service.getProjectDiff('project');
  expect(value.staged).toContain('+new staged');
  expect(value.staged).not.toContain('new unstaged');
  expect(value.unstaged).toContain('+new unstaged');
  expect(value.untracked.find((f) => f.path === 'new 中文 file.txt')?.diff).toContain(
    '+new content',
  );
  expect(value.untracked.find((f) => f.path === 'binary.bin')?.diff).toContain('Binary files');
  expect(value.truncated).toBe(false);
  expect(ctx.codex.starts).toBe(0);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  ctx.codex.ready = false;
  expect(
    (await ctx.service.getThreadDiff((created.result as { threadId: string }).threadId)).staged,
  ).toContain('+new staged');
});
it('keeps subdirectory and excluded-workspace boundaries and never runs text conversion', async () => {
  const ctx = await setup();
  const scope = join(ctx.project, 'scope');
  const excluded = join(scope, 'private');
  await mkdir(excluded, { recursive: true });
  await writeFile(join(scope, 'visible.txt'), 'old\n');
  await writeFile(join(excluded, 'hidden.txt'), 'old\n');
  await writeFile(join(ctx.project, '.gitattributes'), '*.txt diff=unsafe filter=unsafe\n');
  git(ctx.project, 'add', '.');
  git(ctx.project, 'commit', '-m', 'scope');
  const marker = join(ctx.directory, 'textconv-ran');
  git(ctx.project, 'config', 'diff.unsafe.textconv', `touch ${marker}`);
  const filterMarker = join(ctx.directory, 'filter-ran');
  git(ctx.project, 'config', 'filter.unsafe.clean', `touch ${filterMarker}; cat`);
  await writeFile(join(scope, 'visible.txt'), 'visible new\n');
  await writeFile(join(excluded, 'hidden.txt'), 'DO_NOT_DISCLOSE\n');
  await writeFile(join(ctx.project, 'unstaged.txt'), 'outside scope\n');
  const value = await readWorkspaceDiff(await realpath(scope), [await realpath(excluded)]);
  expect(value.unstaged).toContain('visible new');
  expect(value.unstaged).not.toContain('DO_NOT_DISCLOSE');
  expect(value.unstaged).not.toContain('outside scope');
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(filterMarker)).toBe(false);
  git(ctx.project, 'config', 'filter.unsafe.process', `touch ${filterMarker}; exit 1`);
  git(ctx.project, 'config', 'filter.unsafe.required', 'true');
  expect(
    (await readWorkspaceDiff(await realpath(scope), [await realpath(excluded)])).unstaged,
  ).toContain('visible new');
  expect(existsSync(filterMarker)).toBe(false);
});
it('does not follow untracked symlinks and labels bounded content as partial', async () => {
  const ctx = await setup();
  await writeFile(join(ctx.directory, 'private.txt'), 'DO_NOT_DISCLOSE');
  await symlink(join(ctx.directory, 'private.txt'), join(ctx.project, 'link'));
  await writeFile(join(ctx.project, 'large.txt'), 'x'.repeat(129 * 1024));
  const value = await ctx.service.getProjectDiff('project');
  expect(JSON.stringify(value)).not.toContain('DO_NOT_DISCLOSE');
  expect(value.untracked.find((f) => f.path === 'link')?.diff).toContain('120000');
  expect(value.truncated).toBe(true);
});
it('reports non-repositories instead of showing stale or empty changes', async () => {
  const ctx = harness();
  close.push(ctx.close);
  await expect(ctx.service.getProjectDiff('project')).rejects.toMatchObject({
    code: 'GIT_NOT_REPOSITORY',
  });
});

import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';
test('diff opens real staged, unstaged and untracked workspace patches without creating a session', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  const { data } = await (await request.get('/api/projects')).json();
  const cwd = data.find((p: { id: string }) => p.id === 'fixture').rootPath;
  const git = (args: string[]) =>
    execFileSync(
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
    );
  git(['init', '-b', 'main']);
  await writeFile(join(cwd, 'staged.ts'), 'export const staged = 1;\n');
  await writeFile(join(cwd, 'unstaged.ts'), 'export const pending = 1;\n');
  git(['add', 'staged.ts', 'unstaged.ts']);
  git(['commit', '-m', 'baseline']);
  await writeFile(join(cwd, 'staged.ts'), 'export const staged = 2;\n');
  git(['add', 'staged.ts']);
  await writeFile(join(cwd, 'unstaged.ts'), 'export const pending = 2;\n');
  await writeFile(join(cwd, 'new 中文.ts'), 'export const added = true;\n');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('.composer-box textarea').fill('/diff');
  await page.locator('.composer-box textarea').press('Enter');
  const dialog = page.getByRole('dialog', { name: '工作区 Git 变更', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('unstaged.ts', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '已暂存', exact: true }).click();
  await expect(dialog.getByText('staged.ts', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-diff-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: '未跟踪', exact: true }).click();
  await expect(dialog.getByText('new 中文.ts', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-diff-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'))).toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

import { tmpdir } from 'node:os';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';
test('init submits the native task from a draft and preserves existing instructions on retry', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  const { data: projects } = await (await request.get('/api/projects')).json();
  const project = projects.find((p: { id: string }) => p.id === 'fixture');
  const path = join(project.rootPath, 'AGENTS.md');
  await rm(path, { force: true });
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/');
    await confirmCompatibility(page);
    const input = page.locator('.composer-box textarea');
    await input.fill('/init');
    const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/turns'));
    await input.press('Enter');
    expect((await posted).postDataJSON().taskKind).toBe('init');
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(page.locator('.slash-feedback')).toContainText('AGENTS.md');
    const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
    const history = await (await request.get(`/api/threads/${id}`)).json();
    expect(
      history.turns[0].items.find((i: { type: string }) => i.type === 'userMessage').text,
    ).toContain('First check whether any AGENTS.md entry already exists');
    await page.screenshot({ path: join(tmpdir(), 'covro-slash-init-desktop.png'), fullPage: true });
    await writeFile(path, 'Existing project instructions\n');
    await page.setViewportSize({ width: 390, height: 844 });
    await input.fill('/init');
    await page.getByRole('button', { name: '执行命令', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'AGENTS.md 已存在' })).toBeVisible();
    await expect(input).toHaveValue('/init');
    expect(await readFile(path, 'utf8')).toBe('Existing project instructions\n');
    expect((await (await request.get(`/api/threads/${id}`)).json()).turns).toHaveLength(1);
    await page.screenshot({ path: join(tmpdir(), 'covro-slash-init-mobile.png'), fullPage: true });
  } finally {
    await rm(path, { force: true });
  }
});

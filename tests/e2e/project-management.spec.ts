import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { parseConfig, type AppConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';
import { openSidebarSettings } from './helpers';
import type { Project } from '../../src/shared/types';

let directory: string;
let origin: string;
let config: AppConfig;
let codex: DomainCodex;
let runtime: Awaited<ReturnType<typeof startGateway>>;

async function start() {
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
}

async function projects(page: Page): Promise<Project[]> {
  const response = await page.request.get(`${origin}/api/projects`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { data: Project[] }).data;
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codex-project-browser-'));
  await mkdir(join(directory, 'alpha'));
  await mkdir(join(directory, 'beta'));
  await writeFile(join(directory, 'alpha', 'keep.txt'), 'keep project files');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  config = parseConfig(
    {
      port: address.port,
      publicOrigin: [origin],
      dataDir: join(directory, 'data'),
      codex: { home: join(directory, 'codex-home') },
    },
    join(directory, 'config.json'),
  );
  config.demo = true;
  codex = new DomainCodex();
  codex.onStart = (id, turn) => {
    setTimeout(() => codex.complete(id, turn.id), 50);
  };
  await start();
});

test.afterEach(async () => {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
});

// UI helpers below use the same visible form controls as desktop and mobile users.
async function addProject(page: Page, name: string, path: string) {
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加服务器项目', exact: true });
  await dialog.getByRole('textbox', { name: '服务器目录', exact: true }).fill(path);
  await dialog.getByRole('textbox', { name: '项目名称（可选）', exact: true }).fill(name);
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  return (await projects(page)).find((project) => project.name === name)!;
}
const group = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true, includeHidden: true });
async function manageProject(page: Page, name: string) {
  await group(page, name)
    .getByRole('button', { name: `管理项目 ${name}`, exact: true })
    .click();
  return page.getByRole('dialog', { name: '管理项目', exact: true });
}

test('empty startup, add, rename, remove and restore preserve identity and history after restart', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: '添加项目', exact: true }).first()).toBeVisible();
  expect(await projects(page)).toEqual([]);
  await screenshot(page, testInfo, 'projects-empty-desktop');
  const alpha = await addProject(page, '示例项目', join(directory, 'alpha'));
  expect(alpha).toBeTruthy();
  await group(page, '示例项目').getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保留这个项目的会话历史');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const selected = await page.evaluate(
    (id) => localStorage.getItem(`codex-web.selected:${id}`),
    alpha.id,
  );
  const dialog = await manageProject(page, '示例项目');
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('重命名后的项目');
  await screenshot(page, testInfo, 'projects-manage-desktop');
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(group(page, '重命名后的项目')).toBeVisible();
  await runtime.close();
  await start();
  await page.reload();
  await expect(group(page, '重命名后的项目')).toBeVisible();
  await expect(page.locator('.user-text')).toHaveText('保留这个项目的会话历史');
  expect((await projects(page))[0]!.id).toBe(alpha.id);
  expect(
    await page.evaluate((id) => localStorage.getItem(`codex-web.selected:${id}`), alpha.id),
  ).toBe(selected);
  await screenshot(page, testInfo, 'projects-managed-desktop');
  const removeDialog = await manageProject(page, '重命名后的项目');
  await removeDialog.getByRole('button', { name: '移除项目…', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除项目', exact: true })
    .getByRole('button', { name: '确认移除', exact: true })
    .click();
  await expect(group(page, '重命名后的项目')).toHaveCount(0);
  expect(await readFile(join(directory, 'alpha', 'keep.txt'), 'utf8')).toBe('keep project files');
  await runtime.close();
  await start();
  await page.reload();
  expect(await projects(page)).toEqual([]);
  const restored = await addProject(page, '恢复的项目', join(directory, 'alpha'));
  expect(restored.id).toBe(alpha.id);
  await expect(group(page, '恢复的项目').locator('[data-thread-id]')).toHaveCount(1);
  await group(page, '恢复的项目').locator('[data-thread-id]').click();
  await expect(page.locator('.user-text')).toHaveText('保留这个项目的会话历史');
});

test('invalid paths, duplicates and busy removal show recoverable inline errors', async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  const add = page.getByRole('dialog', { name: '添加服务器项目', exact: true });
  await add
    .getByRole('textbox', { name: '服务器目录', exact: true })
    .fill(join(directory, 'missing'));
  await add.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(add.getByRole('alert')).toBeVisible();
  await add
    .getByRole('textbox', { name: '服务器目录', exact: true })
    .fill(join(directory, 'alpha'));
  await add.getByRole('textbox', { name: '项目名称（可选）', exact: true }).fill('项目 A');
  await add.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(add).not.toBeVisible();
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  await add
    .getByRole('textbox', { name: '服务器目录', exact: true })
    .fill(join(directory, 'alpha'));
  await add.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(add.getByRole('alert')).toBeVisible();
  await add.getByRole('button', { name: '取消', exact: true }).click();
  await group(page, '项目 A').getByRole('button', { name: '新建会话', exact: true }).click();
  codex.onStart = undefined;
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保持任务运行');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('执行中');
  const manage = await manageProject(page, '项目 A');
  await manage.getByRole('button', { name: '移除项目…', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除项目', exact: true })
    .getByRole('button', { name: '确认移除', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: '移除项目', exact: true }).getByRole('alert'),
  ).toBeVisible();
  expect(await projects(page)).toHaveLength(1);
});

test('mobile adds server directories and other open tabs immediately follow project changes', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  const other = await context.newPage();
  await other.goto(origin);
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  // The empty-state call to action is accessible without opening the navigation drawer.
  await page.getByRole('main').getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加服务器项目', exact: true });
  await dialog
    .getByRole('textbox', { name: '服务器目录', exact: true })
    .fill(join(directory, 'alpha'));
  await dialog
    .getByRole('textbox', { name: '项目名称（可选）', exact: true })
    .fill('手机添加的项目');
  await screenshot(page, testInfo, 'projects-add-mobile');
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(group(other, '手机添加的项目')).toBeVisible();
  const project = (await projects(page))[0]!;
  const renamed = await other.request.post(`${origin}/api/projects/${project.id}/rename`, {
    headers: { Origin: origin },
    data: { name: '跨页面同步名称' },
  });
  expect(renamed.ok()).toBe(true);
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await expect(group(page, '跨页面同步名称')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, testInfo, 'projects-list-mobile');
  const removed = await other.request.post(`${origin}/api/projects/${project.id}/remove`, {
    headers: { Origin: origin },
    data: {},
  });
  expect(removed.ok()).toBe(true);
  await expect(group(page, '跨页面同步名称')).toHaveCount(0);
  await expect(group(other, '跨页面同步名称')).toHaveCount(0);
});

test('global instructions editor creates, saves, detects conflicts, and protects unsaved changes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  const settings = await openSidebarSettings(page, 'ai');
  await settings.getByRole('button', { name: '全局指令', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑全局指令', exact: true });
  const file = join(directory, 'codex-home', 'AGENTS.md');
  await expect(editor).toContainText(file);
  const textbox = editor.getByRole('textbox', { name: 'AGENTS.md', exact: true });
  await expect(editor).toContainText('AGENTS.md 尚不存在');
  await textbox.fill('# Global instructions\n\nUse TypeScript. 中文指令。\n');
  await editor.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('AGENTS.md 已保存');
  expect(await readFile(file, 'utf8')).toContain('Use TypeScript');
  await textbox.fill('my unsaved changes');
  await writeFile(file, 'external changes');
  await editor.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('已被其他操作修改');
  await expect(textbox).toHaveValue('my unsaved changes');
  await screenshot(page, testInfo, 'instructions-conflict');
  await editor.getByRole('button', { name: '重新读取', exact: true }).click();
  await editor.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(textbox).toHaveValue('external changes');
  await textbox.fill('new saved instructions');
  await editor.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('AGENTS.md 已保存');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.colorScheme = 'dark';
  });
  await screenshot(page, testInfo, 'instructions-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, 'instructions-mobile');
  await textbox.fill('discard me');
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('放弃尚未保存的修改');
  await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(textbox).toHaveValue('discard me');
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await readFile(file, 'utf8')).toBe('new saved instructions');
  const invalid = await page.request.post(`${origin}/api/instructions/global`, {
    headers: { Origin: origin },
    data: { content: 'bad', revision: 'missing', path: join(directory, 'alpha', 'AGENTS.md') },
  });
  expect(invalid.status()).toBe(400);
  await expect(page.locator('.instructions-trigger')).toHaveCount(0);
  await writeFile(join(directory, 'codex-home', 'AGENTS.override.md'), 'active override');
  await openSidebarSettings(page, 'ai');
  await page.getByRole('button', { name: '全局指令', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('AGENTS.override.md');
  await expect(editor.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  const blocked = await page.request.post(`${origin}/api/instructions/global`, {
    headers: { Origin: origin },
    data: {
      content: 'bad',
      revision: (await (await page.request.get(`${origin}/api/instructions/global`)).json())
        .revision,
    },
  });
  expect(blocked.status()).toBe(409);
  expect(await readFile(file, 'utf8')).toBe('new saved instructions');
});

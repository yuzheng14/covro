import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { openSidebarSettings } from './helpers';
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';
import { gitCloneFixture } from '../helpers/git-clone';

let root: string, configPath: string, origin: string, workDir: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let previous: Record<string, string | undefined>;
async function start() {
  const config = await loadConfig({ configPath, development: false });
  config.demo = true;
  runtime = await startGateway(config, {
    codex: new DomainCodex(),
    staticDir: resolve('dist/web'),
  });
}
test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'covro-workdir-browser-')));
  configPath = join(root, 'config.json');
  workDir = join(root, 'projects');
  await mkdir(workDir);
  await mkdir(join(workDir, 'demo'));
  const env = gitCloneFixture(root);
  previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    configPath,
    JSON.stringify({ port: address.port, publicOrigin: [origin], dataDir: './data' }),
  );
  await start();
});
test.afterEach(async () => {
  await runtime?.close();
  for (const [key, value] of Object.entries(previous ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
const settings = (page: Page) => page.getByRole('region', { name: '服务配置', exact: true });
const projectDialog = (page: Page) =>
  page.getByRole('dialog', { name: '添加服务器项目', exact: true });
async function sidebar(page: Page) {
  const trigger = page.getByRole('button', { name: '打开项目与会话', exact: true });
  if ((await trigger.isVisible()) && !(await page.locator('.sidebar-open').count()))
    await trigger.click();
}
async function openAdd(page: Page) {
  await sidebar(page);
  await page
    .getByRole('complementary', { name: '项目与会话' })
    .getByRole('button', { name: '添加项目', exact: true })
    .click();
  return projectDialog(page);
}
async function saveBase(page: Page, path: string) {
  await openSidebarSettings(page, 'service');
  await page.getByRole('button', { name: '服务配置', exact: true }).click();
  const dialog = settings(page);
  await dialog.getByLabel('项目基础目录（workDir，可选）', { exact: true }).fill(path);
  await dialog.getByRole('button', { name: '检查更改', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '保存配置预览' })).toContainText('项目基础目录');
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click();
  return dialog;
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('saves immediately, previews imports and clone defaults, and retains workDir across refresh and restart', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(origin);
  const settingsDialog = await saveBase(page, workDir);
  await expect(
    settingsDialog.getByText('已保存配置与当前运行配置一致', { exact: true }),
  ).toBeVisible();
  await settingsDialog
    .getByLabel('项目基础目录（workDir，可选）', { exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, info, 'workdir-settings-desktop');
  expect(JSON.parse(await readFile(configPath, 'utf8')).workDir).toBe(workDir);
  await page.locator('.settings-heading button').click();
  await expect(settingsDialog).not.toBeVisible();
  let dialog = await openAdd(page);
  const path = dialog.getByRole('textbox', { name: '服务器目录', exact: true });
  await expect(path).toHaveValue(workDir);
  await path.fill('nested/../demo');
  await expect(dialog.locator('.project-path-preview code')).toHaveText(join(workDir, 'demo'));
  await capture(page, info, 'workdir-add-relative-desktop');
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  dialog = await openAdd(page);
  await expect(dialog.getByRole('textbox', { name: '服务器目录', exact: true })).toHaveValue(
    workDir,
  );
  await dialog.getByRole('button', { name: '克隆 Git 仓库', exact: true }).click();
  const repository = dialog.getByRole('textbox', { name: 'Git 仓库地址', exact: true });
  const target = dialog.getByRole('textbox', { name: '服务器目标目录', exact: true });
  await repository.fill('https://example.test/org/first.git');
  await expect(target).toHaveValue(join(workDir, 'first'));
  await repository.fill('git@example.test:org/cloned.git');
  await expect(target).toHaveValue(join(workDir, 'cloned'));
  await expect(dialog.locator('.project-path-preview code')).toHaveText(join(workDir, 'cloned'));
  await capture(page, info, 'workdir-clone-default-desktop');
  await target.fill('custom');
  await repository.fill('ssh://git@example.test/org/another.git');
  await expect(target).toHaveValue('custom');
  await expect(dialog.locator('.project-path-preview code')).toHaveText(join(workDir, 'custom'));
  await target.fill(join(root, 'absolute-clone'));
  await expect(dialog.locator('.project-path-preview code')).toHaveText(
    join(root, 'absolute-clone'),
  );
  await capture(page, info, 'workdir-clone-absolute-desktop');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
  await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await runtime.close();
  await start();
  await page.reload();
  dialog = await openAdd(page);
  await expect(dialog.getByRole('textbox', { name: '服务器目录', exact: true })).toHaveValue(
    workDir,
  );
  await dialog.getByRole('button', { name: '关闭项目管理', exact: true }).click();
  const newBase = join(root, 'new-base');
  await mkdir(newBase);
  await saveBase(page, newBase);
  await page.locator('.settings-heading button').click();
  const projects = (await (await page.request.get(`${origin}/api/projects`)).json()).data;
  expect(projects.map((p: { rootPath: string }) => p.rootPath)).toEqual([
    join(workDir, 'demo'),
    join(root, 'absolute-clone'),
  ]);
  dialog = await openAdd(page);
  await expect(dialog.getByRole('textbox', { name: '服务器目录', exact: true })).toHaveValue(
    newBase,
  );
});

test('mobile handles unavailable workDir, absolute overrides and clearing the setting', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  const dialog = await saveBase(page, workDir);
  await dialog
    .getByLabel('项目基础目录（workDir，可选）', { exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, info, 'workdir-settings-mobile');
  await page.locator('.settings-heading button').click();
  await expect(page.locator('.sidebar-settings-dialog[open]')).toHaveCount(0);
  await expect(page.locator('.sidebar-open')).toBeVisible();
  await rm(workDir, { recursive: true });
  const add = await openAdd(page);
  await expect(add.getByRole('alert')).toContainText('workDir 目录不存在');
  await expect(add.getByRole('button', { name: '添加项目', exact: true })).toBeDisabled();
  await capture(page, info, 'workdir-unavailable-mobile');
  await add.getByRole('textbox', { name: '服务器目录', exact: true }).fill(join(root, 'source'));
  await expect(add.locator('.project-path-preview code')).toHaveText(join(root, 'source'));
  await capture(page, info, 'workdir-add-absolute-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await add.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(add).not.toBeVisible();
  await saveBase(page, '');
  await page.locator('.settings-heading button').click();
  await page.reload();
  const empty = await openAdd(page);
  await expect(empty.getByRole('textbox', { name: '服务器目录', exact: true })).toHaveValue('');
  await empty.getByRole('textbox', { name: '服务器目录', exact: true }).fill('demo');
  await expect(empty.getByRole('alert')).toBeVisible();
  await expect(empty.getByRole('button', { name: '添加项目', exact: true })).toBeDisabled();
});

test('unavailable base cannot be saved and leaves the form editable', async ({ page }, info) => {
  await page.goto(origin);
  const dialog = await saveBase(page, join(root, 'missing'));
  await expect(dialog.getByRole('alert')).toContainText('workDir 目录不存在');
  expect(JSON.parse(await readFile(configPath, 'utf8')).workDir).toBeUndefined();
  await capture(page, info, 'workdir-invalid-setting');
  await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(dialog.getByLabel('项目基础目录（workDir，可选）', { exact: true })).toHaveValue(
    join(root, 'missing'),
  );
});

test('a delayed preview cannot replace the latest path or enable submission early', async ({
  page,
}) => {
  await page.goto(origin);
  await saveBase(page, workDir);
  await page.locator('.settings-heading button').click();
  let release!: () => void;
  const delayed = new Promise<void>((done) => {
    release = done;
  });
  let observed!: () => void;
  const requested = new Promise<void>((done) => {
    observed = done;
  });
  await page.route('**/api/project-path?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('path') === 'first') {
      const response = await route.fetch();
      observed();
      await delayed;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const dialog = await openAdd(page);
  const input = dialog.getByRole('textbox', { name: '服务器目录', exact: true });
  await expect(input).toHaveValue(workDir);
  await input.fill('first');
  await requested;
  await expect(dialog.getByRole('button', { name: '添加项目', exact: true })).toBeDisabled();
  await input.fill('demo');
  await expect(dialog.locator('.project-path-preview code')).toHaveText(join(workDir, 'demo'));
  release();
  await expect(input).toHaveValue('demo');
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const projects = (await (await page.request.get(`${origin}/api/projects`)).json()).data;
  expect(projects[0].rootPath).toBe(join(workDir, 'demo'));
});

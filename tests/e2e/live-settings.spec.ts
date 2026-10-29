import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openModelSettings,
  selectInterfaceLocale,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const evidence = join(tmpdir(), 'covro-live-settings-271');
const mode = (page: Page) => page.getByRole('combobox', { name: '权限模式', exact: true });
const fast = (page: Page) =>
  page.getByRole('button', { name: 'Fast 模式', exact: true, includeHidden: true });
async function chooseMode(page: Page, name: string) {
  await mode(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function chooseModel(page: Page, name: string) {
  await openModelSettings(page);
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.locator('.settings-defaults')).not.toHaveAttribute('data-state', 'saving');
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
  await mkdir(evidence, { recursive: true });
});

test('edits a running session, preserves human approval, publishes Fast/reviewer and sends the final next-turn selection', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await chooseMode(page, '请求批准');
  await send(page, '[mode-approval] 执行中配置验证');
  await expect(page.locator('.action-card')).toBeVisible();
  const id = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  const before = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await chooseModel(page, 'simulated-alternative');
  await page.getByRole('combobox', { name: '推理强度', exact: true }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await expect(page.locator('.settings-pending').first()).toContainText(
    '当前 simulated-model / medium',
  );
  await fast(page).click();
  await expect(page.locator('.settings-live-status')).toContainText('Fast：后续模型步骤生效');
  await page.screenshot({
    path: `${evidence}/desktop-model-fast.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await chooseMode(page, '帮我批准');
  await expect(page.locator('.settings-live-status')).toContainText('已有审批不变');
  await expect(page.locator('.action-card')).toBeVisible();
  const running = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(running.runtimeSettings?.model).toBe(before.runtimeSettings?.model);
  expect(running.runtimeSettings?.reasoningEffort).toBe(before.runtimeSettings?.reasoningEffort);
  expect(
    running.actions
      .filter((action) => action.status === 'pending')
      .map((action) => action.actionId),
  ).toEqual(
    before.actions.filter((action) => action.status === 'pending').map((action) => action.actionId),
  );
  expect(running.liveSettings).toMatchObject({
    serviceTier: 'fast',
    approvalReviewer: 'auto_review',
  });
  await page.screenshot({
    path: `${evidence}/desktop-reviewer-approval.png`,
    fullPage: true,
    animations: 'disabled',
  });
  // Rapid edits are serialized, including a revert to the original future value.
  await openModelSettings(page);
  await fast(page).click();
  await fast(page).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView).liveSettings
          ?.serviceTier,
    )
    .toBe('fast');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await chooseMode(page, '完全访问');
  await expect(page.locator('.settings-live-status')).toContainText('权限：下轮生效');
  await page.reload();
  await expect(mode(page)).toHaveAttribute('data-value', 'full-access');
  await expect(page.locator('.settings-live-status')).toContainText('Fast：后续模型步骤生效');
  await page.setViewportSize({ width: 390, height: 844 });
  await openModelSettings(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `${evidence}/mobile-pending.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.locator('.action-card').getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.settings-live-status')).toHaveCount(0);
  const sending = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/turns'),
  );
  await send(page, '下一轮配置 [title-fail]');
  expect((await sending).postDataJSON().settings).toMatchObject({
    model: 'simulated-alternative',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    permissionMode: 'full-access',
  });
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  const after = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(after.runtimeSettings).toMatchObject({
    model: 'simulated-alternative',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    permissionMode: 'full-access',
  });
});

test('undo reverses an in-flight publication and preserves the running task', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[approval] 撤销执行中设置');
  await expect(page.locator('.action-card')).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/live-settings', async (route) => {
    await gate;
    await route.continue();
  });
  await openModelSettings(page);
  await fast(page).click();
  await expect(page.locator('.settings-live-status')).toContainText('正在更新');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  release();
  const id = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView).liveSettings
          ?.serviceTier,
    )
    .toBe(null);
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(fast(page)).toHaveAttribute('aria-pressed', 'false');
});

test('four locales retain running controls within a 320px viewport', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[approval] 四语执行中设置');
  await expect(page.locator('.action-card')).toBeVisible();
  for (const locale of ['en', 'ja', 'ko', 'zh-Hans']) {
    await selectInterfaceLocale(page, locale);
    await page.setViewportSize({ width: 320, height: 844 });
    const toggle = page.locator('.settings-model-toggle');
    await toggle.click();
    await expect(page.locator('.settings-speed')).toBeEnabled();
    await expect(page.locator('.settings-model')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${evidence}/mobile-${locale}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
});

test('a rejected revert keeps the last acknowledged current speed distinct from next-turn speed', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[approval] 拒绝执行中回退');
  await expect(page.locator('.action-card')).toBeVisible();
  await openModelSettings(page);
  await fast(page).click();
  await expect(page.locator('.settings-live-status')).toContainText('Fast：后续模型步骤生效');
  await page.route('**/live-settings', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'LIVE_SETTINGS_UNAVAILABLE', message: '测试拒绝执行中更新' } },
    }),
  );
  await fast(page).click();
  await expect(fast(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.settings-live-status')).toContainText('下轮生效');
  await expect(page.locator('.settings-pending').first()).toContainText(
    '速度待生效：Fast 关；当前：Fast 开',
  );
  await expect(page.locator('.settings-live-status')).not.toContainText('后续模型步骤生效');
  await expect(page.locator('.action-card')).toBeVisible();
});

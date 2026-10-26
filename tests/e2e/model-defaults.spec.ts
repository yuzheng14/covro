import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  createEmptyThread,
  expectThreadReady,
  projectGroup,
  saveConversationHistory,
} from './helpers';

const model = (page: Page) =>
  page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
const effort = (page: Page) =>
  page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
async function choose(page: Page, control: '模型' | '推理强度', value: string) {
  await openModelSettings(page);
  await page.getByRole('combobox', { name: control, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function saved(page: Page) {
  await expect(page.locator('.settings-defaults')).toHaveText('已保存为 Codex 新会话默认值');
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('remembers explicit model and effort choices across new threads, projects and reloads without rewriting history', async ({
  page,
}) => {
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/model-defaults'))
      writes.push(request.postDataJSON().settings);
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(effort(page)).toHaveAttribute('data-value', 'medium');
  const original = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await saveConversationHistory(page);
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-model-defaults-before.png' });
  await choose(page, '模型', 'simulated-alternative');
  await saved(page);
  await choose(page, '推理强度', 'high');
  await saved(page);
  await expect(page.locator('.settings-pending')).toContainText('当前 simulated-model / medium');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-model-defaults-saved.png' });
  expect(writes).toEqual([
    { model: 'simulated-alternative', reasoningEffort: 'medium' },
    { model: 'simulated-alternative', reasoningEffort: 'high' },
  ]);
  await createEmptyThread(page);
  await expect(model(page)).toHaveAttribute('data-value', 'simulated-alternative');
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await page.reload();
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
  await openModelSettings(page);
  await effort(page).click();
  await page.screenshot({ path: '/tmp/codex-model-defaults-new-thread.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator(`[data-thread-id="${original}"]`).click();
  await expect(model(page)).toHaveAttribute('data-value', 'simulated-model');
  await expect(effort(page)).toHaveAttribute('data-value', 'medium');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(model(page)).toHaveAttribute('data-value', 'simulated-alternative');
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
  expect(writes).toHaveLength(2);
});

test('waits for a save before allowing another selection or a new thread', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/*/model-defaults', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, '推理强度', 'high');
  await expect(page.locator('.settings-defaults')).toContainText('正在保存');
  await expect(model(page)).toBeDisabled();
  await expect(effort(page)).toBeDisabled();
  await expect(createThreadButton(page)).toBeDisabled();
  release();
  await saved(page);
  await createEmptyThread(page);
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('keeps the current proposal on a rejected save and lets an explicit retry save the defaults', async ({
  page,
}) => {
  await page.route('**/api/projects/*/model-defaults', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'CONFIG_WRITE_FAILED', message: '测试配置不可写' } },
    }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await choose(page, '推理强度', 'high');
  await expect(page.locator('.settings-defaults')).toContainText('未能确认默认值已保存');
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toContainText('当前 simulated-model / medium');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator('.settings-pending > span')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page
    .locator('.composer-box')
    .screenshot({ path: '/tmp/codex-model-defaults-failed-mobile.png', animations: 'disabled' });
  await page.unroute('**/api/projects/*/model-defaults');
  await page.getByRole('button', { name: '重新保存默认值', exact: true }).click();
  await saved(page);
  await page.setViewportSize({ width: 1280, height: 844 });
  await createEmptyThread(page);
  await expect(effort(page)).toHaveAttribute('data-value', 'high');
});

test('distinguishes a saved default from a higher-priority override', async ({ page }) => {
  await page.route('**/api/projects/*/model-defaults', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), result: { status: 'okOverridden' } },
    });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, '推理强度', 'high');
  await expect(page.locator('.settings-defaults')).toContainText('被更高优先级配置覆盖');
  await page
    .locator('.composer-box')
    .screenshot({ path: '/tmp/codex-model-defaults-overridden.png' });
});

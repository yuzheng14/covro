import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import { compatibilityDialog, confirmCompatibility, controlRuntime, testOrigin } from './helpers';

const headers = { Origin: testOrigin };
const link = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const row = (page: Page, id: string) => link(page, id).locator('..');
const unread = (page: Page, id: string) =>
  row(page, id).locator('.thread-status-indicator[data-status="completed"]');
const latestResult = (page: Page) => page.getByText('模拟任务已完成。', { exact: true }).last();

async function submit(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(path, {
    headers,
    data: { clientOperationId: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}

async function create(request: APIRequestContext, title: string) {
  const operation = await submit(request, '/api/projects/fixture/threads');
  const { threadId } = operation.result as { threadId: string };
  await submit(request, `/api/threads/${threadId}/rename`, { name: title });
  const seed = await start(request, threadId, '已有会话历史 [title-fail]');
  await waitCompleted(request, threadId, seed);
  return threadId;
}

async function history(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}

async function start(request: APIRequestContext, id: string, text = '检查本轮结果') {
  const operation = await submit(request, `/api/threads/${id}/turns`, { text });
  return (operation.result as { turnId: string }).turnId;
}

async function waitCompleted(request: APIRequestContext, id: string, turnId: string) {
  await expect
    .poll(async () => (await history(request, id)).turns.find((turn) => turn.id === turnId)?.status)
    .toBe('completed');
}

async function approve(request: APIRequestContext, id: string) {
  await expect
    .poll(
      async () =>
        (await history(request, id)).actions.filter((action) => action.status === 'pending').length,
    )
    .toBe(1);
  const action = (await history(request, id)).actions.find((entry) => entry.status === 'pending')!;
  await submit(request, `/api/actions/${action.actionId}/resolve`, {
    resolution: { decision: action.options[0]!.id },
  });
}

async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await page.bringToFront();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('completion stays unread until its latest result is viewed and later turns notify again', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const target = await create(request, '等待阅读的完成结果');
  const current = await create(request, '当前正在查看的会话');
  await link(page, current).click();
  await expect(latestResult(page)).toBeVisible();
  const firstTurn = await start(request, target);
  await waitCompleted(request, target, firstTurn);
  await expect(unread(page, target)).toHaveAccessibleName('已完成 · 未读');
  await row(page, target).locator('.thread-details-trigger').click();
  await expect(row(page, target).locator('.thread-details')).toContainText('阅读状态');
  await expect(row(page, target).locator('.thread-details')).toContainText('未读');
  await screenshot(page, testInfo, 'thread-unread-before');

  await link(page, target).click();
  await expect(latestResult(page)).toBeInViewport();
  await expect(unread(page, target)).toHaveCount(0);
  await row(page, target).locator('.thread-details-trigger').click();
  await expect(row(page, target).locator('.thread-details')).toContainText('已读');
  await screenshot(page, testInfo, 'thread-unread-after');
  await row(page, target).locator('.thread-details-trigger').click();

  await link(page, current).click();
  await page.reload();
  await expect(link(page, target)).toBeVisible();
  await expect(unread(page, target)).toHaveCount(0);
  await submit(request, `/api/threads/${target}/rename`, { name: '重命名后仍然已读' });
  await expect(link(page, target).locator('.thread-title')).toHaveText('重命名后仍然已读');
  await expect(unread(page, target)).toHaveCount(0);

  const nextTurn = await start(request, target, '重新检查下一轮结果');
  expect(nextTurn).not.toBe(firstTurn);
  await waitCompleted(request, target, nextTurn);
  await expect(unread(page, target)).toHaveAccessibleName('已完成 · 未读');
  const system = await controlRuntime(request, { version: 'fixture-unverified-read' });
  expect(system.compatibilityConfirmation).toBe('required');
  await expect(compatibilityDialog(page)).toBeVisible();
  await expect(unread(page, target)).toHaveAccessibleName('已完成 · 未读');
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
  await link(page, target).click();
  await expect(latestResult(page)).toBeInViewport();
  await expect(unread(page, target)).toHaveCount(0);
});

test('an unfocused tab cannot read a completion and receives another tab read update', async ({
  page,
  request,
  context,
}) => {
  await open(page);
  const target = await create(request, '后台标签中的会话');
  const current = await create(request, '前台正在查看的会话');
  await link(page, current).click();
  const other = await context.newPage();
  // Headless Chromium reports every page focused, even after bringToFront. Model the
  // unfocused browser state explicitly while keeping completion and storage events real.
  await other.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false });
  });
  await other.goto('/');
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  await link(other, target).click();
  const turnId = await start(request, target, '[approval] 等待前台阅读');
  await expect(other.locator('.action-card')).toHaveCount(1);
  await page.bringToFront();
  await expect.poll(() => other.evaluate(() => document.hasFocus())).toBe(false);
  await approve(request, target);
  await waitCompleted(request, target, turnId);
  await expect(other.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(unread(page, target)).toHaveAccessibleName('已完成 · 未读');
  await expect(unread(other, target)).toHaveAccessibleName('已完成 · 未读');

  await link(page, target).click();
  await expect(latestResult(page)).toBeInViewport();
  await expect(unread(page, target)).toHaveCount(0);
  // The second page stays unfocused; its DOM must react to the shared read record.
  await expect.poll(() => other.evaluate(() => document.hasFocus())).toBe(false);
  await expect(unread(other, target)).toHaveCount(0);
  await other.close();
});

test.describe('touch reading', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('completion below the visible content remains unread until the latest result is reached', async ({
    page,
    request,
  }, testInfo) => {
    await open(page);
    const id = await create(request, '查看最新结果后清除完成提示');
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await link(page, id).tap();
    const turnId = await start(
      request,
      id,
      '[approval]\n' +
        Array.from({ length: 80 }, (_, index) => `检查第 ${index + 1} 条历史记录。`).join('\n'),
    );
    await expect(page.locator('.action-card')).toHaveCount(1);
    const conversation = page.locator('.conversation-scroll');
    await conversation.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByRole('button', { name: '回到最新内容', exact: true })).toBeVisible();
    await approve(request, id);
    await waitCompleted(request, id, turnId);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(latestResult(page)).not.toBeInViewport();
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await expect(unread(page, id)).toHaveAccessibleName('已完成 · 未读');
    await row(page, id).locator('.thread-details-trigger').tap();
    await expect(row(page, id).locator('.thread-details')).toContainText('未读');
    await screenshot(page, testInfo, 'thread-unread-mobile');
    await page.getByRole('button', { name: '关闭导航', exact: true }).tap();
    await page.getByRole('button', { name: '回到最新内容', exact: true }).tap();
    // A streamed update after motion starts must not restore a halfway scroll anchor.
    await page.waitForFunction(() => {
      const box = document.querySelector('.conversation-scroll')!;
      return box.scrollTop > 0;
    });
    await submit(request, `/api/threads/${id}/rename`, { name: '滚动中收到会话更新' });
    await expect(latestResult(page)).toBeInViewport();
    // Keep the result unobscured until the asynchronous visibility observer confirms reading.
    await expect(unread(page, id)).toHaveCount(0);
    await screenshot(page, testInfo, 'thread-unread-mobile-latest');
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await expect(unread(page, id)).toHaveCount(0);
    await expect(row(page, id).locator('.thread-details')).toContainText('已读');
  });
});

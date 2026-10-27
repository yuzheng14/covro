import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { ServerMessage, ThreadPage, ThreadView } from '../../src/shared/types';
import {
  createEmptyThread,
  confirmCompatibility,
  expectThreadReady,
  controlRuntime,
} from './helpers';

const input = (page: Page) => page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
const feedback = (page: Page) => page.locator('.slash-feedback');
async function newThread(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function finishTurn(page: Page, text: string) {
  const before = await page.locator('.turn').count();
  await input(page).fill(text);
  await input(page).press('Enter');
  await expect(page.locator('.turn')).toHaveCount(before + 1);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test.afterEach(async ({ request }, testInfo) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  const threads = (await response.json()) as ThreadPage;
  for (const thread of threads.data) {
    const turn = thread.turns.findLast((entry) =>
      ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
    );
    if (turn)
      await request.post(`/api/threads/${thread.id}/interrupt`, {
        headers: { Origin: new URL(testInfo.project.use.baseURL!).origin },
        data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
      });
  }
});

test('/export downloads full saved Markdown even when the browser only has a history slice', async ({
  page,
}) => {
  let clip = false;
  const slice = (thread: ThreadView) => ({
    ...thread,
    turns: thread.turns.slice(-1),
    historyTruncated: true,
  });
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (clip && message.type === 'snapshot') message.data = slice(message.data);
      if (clip && message.type === 'event' && message.kind === 'thread')
        message.payload = slice(message.payload as ThreadView);
      socket.send(JSON.stringify(message));
    });
  });
  const id = await newThread(page);
  await finishTurn(page, '第一轮：必须包含在下载文件中');
  await finishTurn(page, '第二轮：浏览器只展示这一轮');
  clip = true;
  await page.route(`**/api/threads/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: slice((await response.json()) as ThreadView) });
  });
  await page.route(`**/api/threads/${id}/snapshot`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({ response, json: { ...snapshot, data: slice(snapshot.data) } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      get() {
        throw new Error('Export must not use the clipboard');
      },
    });
  });
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(page.locator('.user-text')).toHaveText('第二轮：浏览器只展示这一轮');
  let submitted = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') submitted++;
  });
  await input(page).fill('/export');
  const downloadEvent = page.waitForEvent('download');
  await input(page).press('Enter');
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`codex-thread-${id}-history.md`);
  expect(await download.failure()).toBeNull();
  const markdown = await readFile((await download.path())!, 'utf8');
  expect(markdown).toContain('第一轮：必须包含在下载文件中');
  expect(markdown).toContain('第二轮：浏览器只展示这一轮');
  expect(markdown.match(/^## 第 \d+ 轮/gm)).toHaveLength(2);
  expect(markdown).toContain('已保存会话历史快照');
  expect(markdown).not.toContain('会话历史已截断');
  await expect(input(page)).toHaveValue('');
  await expect(feedback(page)).toContainText('Markdown 下载');
  expect(submitted).toBe(0);
  await page.screenshot({ path: '/tmp/codex-slash-export-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await input(page).fill('/export');
  await expect(page.getByRole('option', { name: /^\/export\b/ })).toBeVisible();
  await page.screenshot({
    path: '/tmp/codex-slash-export-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('/export labels an active task as a partial snapshot without stopping or steering it', async ({
  page,
}) => {
  const id = await newThread(page);
  await input(page).fill('[approval] 导出时仍待审批');
  await input(page).press('Enter');
  await expect(page.locator('.action-card')).toBeVisible();
  let submitted = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') submitted++;
  });
  await input(page).fill('/export');
  const downloadEvent = page.waitForEvent('download');
  await input(page).press('Enter');
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`codex-thread-${id}-history-partial.md`);
  const markdown = await readFile((await download.path())!, 'utf8');
  expect(markdown).toContain('不是完整的最终结果');
  expect(markdown).toContain('此轮尚未完成');
  await expect(feedback(page)).toContainText('未完成');
  await expect(page.locator('.action-card')).toBeVisible();
  expect(submitted).toBe(0);
});

test('failed exports and extra arguments preserve the draft and never download a cached substitute', async ({
  page,
}) => {
  await newThread(page);
  let downloads = 0;
  let reads = 0;
  page.on('download', () => downloads++);
  await page.route('**/api/threads/*/export', async (route) => {
    reads++;
    await route.fulfill({
      status: 502,
      json: { error: { code: 'EXPORT_FAILED', message: '无法读取完整历史' } },
    });
  });
  await input(page).fill('/export');
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await expect(feedback(page)).toContainText('无法读取完整历史');
  await expect(input(page)).toHaveValue('/export');
  expect(reads).toBe(1);
  await input(page).fill('/export another-thread');
  await input(page).press('Enter');
  await expect(feedback(page)).toContainText('不接受参数');
  await expect(input(page)).toHaveValue('/export another-thread');
  expect(reads).toBe(1);
  expect(downloads).toBe(0);
});

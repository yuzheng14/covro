import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ThreadPage, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';

const evidence = join(tmpdir(), 'codex-reconnect-evidence');
const headers = { Origin: testOrigin };
const notice = (page: Page) => page.getByTestId('codex-reconnect-status');
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const turnStatus = (page: Page) => page.locator('.turn-heading .status').last();
async function start(page: Page, prompt: string) {
  await input(page).fill(prompt);
  await send(page).click();
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function currentThread(page: Page, threadId: string) {
  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createEmptyThread(page);
  await expectThreadReady(page);
});
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  for (const thread of ((await response.json()) as ThreadPage).data) {
    const turn = thread.turns.findLast((entry) =>
      ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
    );
    if (turn)
      await request.post(`/api/threads/${thread.id}/interrupt`, {
        headers,
        data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
      });
  }
});

test('normal thinking, quiet waiting and tool output never claim Codex is reconnecting', async ({
  page,
}) => {
  await start(page, '[codex-thinking] 正常分析并执行任务');
  await expect(page.locator('.activity-label')).toContainText(['思考过程']);
  await expect(turnStatus(page)).toHaveText('执行中');
  // The simulator intentionally stays quiet for 3 seconds without an error notification.
  await page.waitForTimeout(1600);
  await expect(notice(page)).toHaveCount(0);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.activity .command-summary')).toContainText('printf');
  await expect(turnStatus(page)).toHaveText('已完成');
  await expect(notice(page)).toHaveCount(0);
});

test('retry updates survive tool completion, reload and browser disconnection and stay scoped to their thread', async ({
  page,
  context,
}) => {
  const threadId = await start(page, '[codex-retry-hold] 等待 Codex 恢复模型连接');
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await expect(notice(page)).toHaveAttribute('role', 'status');
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await notice(page).getByText('连接详情', { exact: true }).click();
  await expect(notice(page)).toContainText('Reconnecting... 1/5');
  await expect(page.locator('.activity-status')).toHaveText('已完成');
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await expect(notice(page)).toContainText('Reconnecting... 2/5');
  const snapshot = await currentThread(page, threadId);
  expect(snapshot.turns.at(-1)?.reconnect).toEqual({
    status: 'retrying',
    message: 'Reconnecting... 2/5 (stream disconnected before completion)',
    errorCode: 'responseStreamDisconnected',
  });
  await page.reload();
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await expect(notice(page).locator('details')).not.toHaveAttribute('open');
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await expect(notice(page)).toContainText('上次已知');
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(notice(page)).not.toContainText('上次已知');
  await createEmptyThread(page);
  await expectThreadReady(page);
  await start(page, '另一个会话正常执行');
  await expect(turnStatus(page)).toHaveText('已完成');
  await expect(notice(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${threadId}"]`).click();
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await expect(page.getByRole('button', { name: '中断', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(turnStatus(page)).toHaveText('已中断');
  await expect(notice(page)).toHaveCount(0);
});

test('interrupting a retry prevents delayed progress from reviving its banner or turn', async ({
  page,
}) => {
  const threadId = await start(page, '[codex-retry-recover] 中断正在重连的任务');
  await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(turnStatus(page)).toHaveText('已中断');
  await expect(notice(page)).toHaveCount(0);
  // Cross both retry and model-recovery timers after the accepted interruption.
  await page.waitForTimeout(4200);
  const snapshot = await currentThread(page, threadId);
  expect(snapshot.turns.at(-1)?.status).toBe('interrupted');
  expect(snapshot.turns.at(-1)?.reconnect).toBeUndefined();
  await expect(page.getByText('连接已恢复，继续处理任务。', { exact: true })).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} clears reconnecting as soon as model progress resumes, before turn completion`, async ({
    page,
  }) => {
    const threadId = await start(page, '[codex-retry-recover] 恢复模型连接后继续任务');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
    await expect(notice(page)).toContainText('Codex 正在重新连接…');
    await expect(notice(page)).toContainText('Codex 会自动重试');
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    await expect(page.getByRole('textbox', { name: '追加要求', exact: true })).toHaveValue('');
    await screenshot(page, `codex-retrying-${viewport.name}`);
    await expect(page.getByText('连接已恢复，继续处理任务。', { exact: true })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    await expect(turnStatus(page)).toHaveText('执行中');
    await screenshot(page, `codex-recovered-${viewport.name}`);
    await expect(turnStatus(page)).toHaveText('已完成');
    expect((await currentThread(page, threadId)).turns.at(-1)?.reconnect).toBeUndefined();
    await page.reload();
    await expect(turnStatus(page)).toHaveText('已完成');
    await expect(notice(page)).toHaveCount(0);
  });

  test(`${viewport.name} shows final reconnect failure with a usable next turn and preserved history`, async ({
    page,
  }) => {
    const threadId = await start(page, '[codex-retry-fail] 模型连接重试耗尽');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(notice(page)).toHaveAttribute('data-state', 'retrying');
    await expect(notice(page)).toHaveAttribute('data-state', 'failed');
    await expect(notice(page)).toHaveAttribute('role', 'alert');
    await expect(notice(page)).toContainText('Codex 重新连接失败');
    await expect(notice(page)).toContainText('重新发送要求以继续');
    await expect(turnStatus(page)).toHaveText('失败');
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    await expect(notice(page).locator('details')).not.toHaveAttribute('open');
    await screenshot(page, `codex-reconnect-failed-${viewport.name}`);
    await notice(page).getByText('连接详情', { exact: true }).click();
    await expect(notice(page)).toContainText('exceeded retry limit');
    expect((await currentThread(page, threadId)).turns.at(-1)?.reconnect?.status).toBe('failed');
    await page.reload();
    await expect(notice(page)).toHaveAttribute('data-state', 'failed');
    await input(page).fill('连接恢复后继续处理任务');
    await expect(send(page)).toBeEnabled();
    await send(page).click();
    await expect(page.locator('.turn')).toHaveCount(2);
    await expect(turnStatus(page)).toHaveText('已完成');
    await expect(page.locator('.codex-reconnect-pinned')).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: '第 1 轮', exact: true })
        .getByTestId('codex-reconnect-status'),
    ).toHaveAttribute('data-state', 'failed');
    expect((await currentThread(page, threadId)).turns.at(-1)?.reconnect).toBeUndefined();
  });
}

for (const width of [1280, 390]) {
  test(`native capacity retry shows its reason and attempt at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await start(page, '[codex-capacity-native] 等待当前模型恢复容量');
    await expect(notice(page)).toContainText('模型繁忙，正在重试');
    await expect(notice(page)).toContainText('第 1 / 5 次重试');
    await notice(page).getByText('连接详情', { exact: true }).click();
    await expect(notice(page)).toContainText('Selected model is at capacity.');
    await screenshot(page, `capacity-native-${width}`);
    await page.getByRole('button', { name: '中断', exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
  });
}

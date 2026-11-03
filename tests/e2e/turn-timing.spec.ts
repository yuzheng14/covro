import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const evidence = join(tmpdir(), 'codex-issue-62-evidence');
const completion = (page: Page) => page.getByRole('group', { name: '本轮完成信息' });
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

test.use({ timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1280 } });
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

test('each completed turn retains upstream timing through refresh, reconnect and thread switching', async ({
  page,
  context,
}) => {
  await send(page, '[turn-timing:cross-day] 完成跨午夜的任务');
  await expect(completion(page)).toHaveText(
    '已完成 · 耗时 2 分 15 秒 · TPS 未知 · 本轮 token 未报告 · 完成于 2026-10-15 00:01:15（UTC+08:00）',
  );
  await expect(completion(page).locator('time')).toHaveAttribute(
    'datetime',
    '2026-10-14T16:01:15.000Z',
  );
  await send(page, '[turn-timing:hours] 完成第二轮较长的任务');
  await expect(completion(page)).toHaveCount(2);
  await expect(completion(page).last()).toHaveText(
    '已完成 · 耗时 1 小时 1 分 1 秒 · TPS 未知 · 本轮 token 未报告 · 完成于 2026-10-16 14:32:08（UTC+08:00）',
  );
  const original = await completion(page).allTextContents();
  const threadId = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.ok()).toBe(true);
  const thread = (await response.json()) as ThreadView;
  expect(thread.turns.map(({ durationMs, completedAt }) => ({ durationMs, completedAt }))).toEqual([
    { durationMs: 135_000, completedAt: Date.parse('2026-10-14T16:01:15Z') },
    { durationMs: 3_661_000, completedAt: Date.parse('2026-10-16T06:32:08Z') },
  ]);
  await page.screenshot({
    path: join(evidence, 'multi-turn-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expect(completion(page)).toHaveText(original);
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(completion(page)).toHaveText(original);
  await createEmptyThread(page);
  await expect(completion(page)).toHaveCount(0);
  // Selecting the saved thread uses the same UI path as normal navigation.
  await page.locator(`[data-thread-id="${threadId}"]`).click();
  await expect(completion(page)).toHaveText(original);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(completion(page)).toHaveText(original);
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await completion(page).last().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: join(evidence, 'completion-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('historical duration and completion time degrade independently without guessing', async ({
  page,
}) => {
  for (const [scenario, expected] of [
    ['duration-only', '已完成 · 耗时 2 分 15 秒 · TPS 未知 · 本轮 token 未报告 · 完成时间未知'],
    [
      'time-only',
      '已完成 · 耗时未知 · TPS 未知 · 本轮 token 未报告 · 完成于 2026-10-15 00:01:15（UTC+08:00）',
    ],
    ['missing', '已完成 · 耗时未知 · TPS 未知 · 本轮 token 未报告 · 完成时间未知'],
  ]) {
    await send(page, `[turn-timing:${scenario}] 查看旧会话的完成信息`);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(completion(page).last()).toHaveText(expected!);
  }
  await expect(completion(page)).toHaveCount(3);
  await expect(completion(page).locator('time')).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.screenshot({
    path: join(evidence, 'missing-history.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const original = await completion(page).allTextContents();
  await page.reload();
  await expect(completion(page)).toHaveText(original);
});

test('running, interrupted and failed turns never display successful completion', async ({
  page,
}) => {
  await send(page, '[approval] 等待人工审批');
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(completion(page)).toHaveCount(0);
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已中断');
  await expect(completion(page)).toHaveCount(0);
  await send(page, '[codex-retry-fail] 验证失败状态');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('失败');
  await expect(completion(page)).toHaveCount(0);
});

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import type { ThreadView } from '../../src/shared/types';
import {
  chooseSelectOption,
  openModelSettings,
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';

const evidence = join(tmpdir(), 'covro-capacity-retry-evidence');
const notice = (page: Page) => page.getByTestId('capacity-retry-status');
const selectedId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')!);
async function snapshot(page: Page) {
  return (await (
    await page.request.get(`/api/threads/${await selectedId(page)}`)
  ).json()) as ThreadView;
}
async function start(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}
async function capture(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
});

for (const width of [1280, 390]) {
  test(`capacity recovery survives reload and preserves one original prompt at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await start(page, '[capacity-recover] 使用当前模型完成任务');
    await expect(notice(page)).toHaveAttribute('data-state', 'waiting');
    await expect(notice(page)).toContainText('重试 1/3');
    await expect(notice(page)).toContainText('秒后');
    await expect(notice(page).locator('.model-capacity-label')).toHaveText('模型容量不足');
    await expect(page.locator('.codex-reconnect-pinned')).toHaveCount(0);
    const labelBox = (await notice(page).locator('.model-capacity-label').boundingBox())!;
    const progressBox = (await notice(page).locator('.model-capacity-progress').boundingBox())!;
    expect(progressBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
    expect(Math.abs(progressBox.y - labelBox.y)).toBeLessThan(10);
    await expect(notice(page)).not.toContainText('6 秒后');
    await expect(page.locator('.error-banner:not(.model-capacity-notice)')).toHaveCount(0);
    const initial = (await snapshot(page)).capacityRetry;
    await capture(page, `waiting-${width}`);
    await page.reload();
    await expect(notice(page)).toHaveAttribute('data-state', 'waiting');
    expect((await snapshot(page)).capacityRetry?.nextAttemptAt).toBe(initial?.nextAttemptAt);
    await expect(page.getByText('容量恢复，继续处理原任务。', { exact: true })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    const done = await snapshot(page);
    expect(done.turns).toHaveLength(2);
    expect(done.turns.flatMap((t) => t.items).filter((i) => i.type === 'userMessage')).toHaveLength(
      1,
    );
    expect(done.turns.at(-1)?.status).toBe('completed');
    await expect(page.locator('.turn')).toHaveCount(1);
    await capture(page, `recovered-${width}`);
  });
}

test('cancellation stops the timer and manual retry uses the newly selected model', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await start(page, '[capacity-recover] 允许取消和手动继续');
  await expect(notice(page)).toHaveAttribute('data-state', 'waiting');
  await notice(page).getByRole('button', { name: '取消重试', exact: true }).click();
  await expect(notice(page)).toHaveAttribute('data-state', 'cancelled');
  await capture(page, 'cancelled-390');
  await page.waitForTimeout(5500);
  expect((await snapshot(page)).turns).toHaveLength(1);
  await openModelSettings(page);
  await chooseSelectOption(
    page,
    page.getByRole('combobox', { name: '模型', exact: true }),
    'simulated-alternative',
  );
  await page.keyboard.press('Escape');
  await notice(page).getByRole('button', { name: '使用所选模型重试', exact: true }).click();
  await expect(page.getByText('容量恢复，继续处理原任务。', { exact: true })).toBeVisible();
  expect((await snapshot(page)).runtimeSettings?.model).toBe('simulated-alternative');
  expect(
    (await snapshot(page)).turns.flatMap((t) => t.items).filter((i) => i.type === 'userMessage'),
  ).toHaveLength(1);
});

test('capacity exhaustion ends after three retries and keeps a manual recovery action', async ({
  page,
}) => {
  test.setTimeout(60000);
  await start(page, '[capacity-fail] 持续容量不足');
  await expect(notice(page)).toHaveAttribute('data-state', 'waiting');
  await expect(notice(page)).toHaveAttribute('data-state', 'stopped', { timeout: 45000 });
  await expect(notice(page)).toContainText('已达上限');
  await expect(
    notice(page).getByRole('button', { name: '使用所选模型重试', exact: true }),
  ).toBeEnabled();
  expect((await snapshot(page)).turns).toHaveLength(4);
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(page.locator('.error-banner:not(.model-capacity-notice)')).toHaveCount(0);
  expect((await snapshot(page)).execution).toBeUndefined();
  await capture(page, 'exhausted-1280');
});

test('partial tool work remains visible and is never automatically replayed', async ({ page }) => {
  await start(page, '[capacity-partial] 已执行工具后容量不足');
  await expect(notice(page)).toHaveAttribute('data-state', 'stopped');
  await expect(notice(page)).toContainText('本轮已有输出或工具操作');
  await page.waitForTimeout(5500);
  expect((await snapshot(page)).turns).toHaveLength(1);
  await notice(page).getByRole('button', { name: '使用所选模型重试', exact: true }).click();
  await expect(page.getByText('容量恢复，继续处理原任务。', { exact: true })).toBeVisible();
  expect(
    (await snapshot(page)).turns
      .flatMap((t) => t.items)
      .filter((i) => i.type === 'commandExecution'),
  ).toHaveLength(1);
  await capture(page, 'partial-manual-1280');
});

test('quoted capacity text and other structured errors do not trigger retries', async ({
  page,
}) => {
  await start(page, '[capacity-quote] 引用错误文本');
  await expect(
    page.getByText('Selected model is at capacity. Please try a different model.', { exact: true }),
  ).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await start(page, '[capacity-other] 其他结构化错误');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('失败');
  await expect(notice(page)).toHaveCount(0);
  await page.waitForTimeout(5500);
  expect((await snapshot(page)).turns).toHaveLength(2);
});

test('a replacement request invalidates the old cancellation target and pending timer', async ({
  page,
}) => {
  await start(page, '[capacity-recover] 原请求');
  await expect(notice(page)).toHaveAttribute('data-state', 'waiting');
  const old = (await snapshot(page)).capacityRetry!;
  await start(page, '替代原任务的新请求');
  await expect(notice(page)).toHaveCount(0);
  const response = await page.request.post(`/api/threads/${await selectedId(page)}/retry/cancel`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), expectedTurnId: old.rootTurnId },
  });
  expect(response.status()).toBe(409);
  await page.waitForTimeout(5500);
  expect((await snapshot(page)).turns).toHaveLength(2);
});

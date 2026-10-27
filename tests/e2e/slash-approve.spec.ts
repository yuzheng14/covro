import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';
test('approval requires choosing the exact denial, cancels safely, and submits once without a new task', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const input = page.locator('.composer-box textarea');
  await input.fill('[auto-review-denied] Inspect the example action');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await input.fill('/approve');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '已拒绝的操作' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '单次授权', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox').selectOption({ index: 1 });
  await expect(dialog.locator('pre')).toContainText('curl --fail');
  await page.screenshot({
    path: join(tmpdir(), 'covro-slash-approve-desktop.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue('/approve');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.slash-feedback')).toHaveText('已取消授权。');
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').selectOption({ index: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-approve-mobile.png'), fullPage: true });
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/approve'));
  await dialog.getByRole('button', { name: '单次授权', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.confirm).toBe(true);
  expect(body.event).toBeUndefined();
  await expect(page.locator('.slash-feedback')).toContainText('已记录重试授权');
  await expect(page.locator('.turn')).toHaveCount(1);
  await input.fill('/approve');
  await page.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(dialog).toContainText('没有可重试的拒绝记录');
});

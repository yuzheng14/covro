import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';
test('recap shows a separate result without adding messages or changing the thread', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const input = page.locator('.composer-box textarea');
  await input.fill('Inspect the current project');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const count = await page.locator('.turn').count();
  await input.fill('/recap');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '会话摘要', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('下一步');
  await expect(page.locator('.turn')).toHaveCount(count);
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-recap-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-recap-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(input).toHaveValue('');
});

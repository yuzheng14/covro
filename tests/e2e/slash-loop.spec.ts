import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  saveConversationHistory,
} from './helpers';

test('creates a fixed loop and retains its controls and state after reload', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await saveConversationHistory(page);
  const input = page.locator('.composer-box textarea');
  const dialog = page.getByRole('dialog', { name: '会话循环' });

  await input.fill('/loop');
  await expect(page.getByRole('option', { name: /loop/ })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'covro-345-loop-command.png') });
  await input.fill('/loop 5m 检查当前 PR 的 CI 状态');
  await input.press('Enter');
  const row = dialog.locator('.session-loop-row');
  await expect(row).toContainText('检查当前 PR 的 CI 状态');
  await expect(row).toContainText('每 5 分钟');
  await expect(row).toContainText('下次');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-scheduled.png') });

  await row.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(row).toContainText('已暂停');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-paused.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await input.fill('/loop');
  await input.press('Enter');
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toContainText('已排程');
  await row.getByRole('button', { name: '取消循环', exact: true }).click();
  await expect(row).toContainText('已取消');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-cancelled.png') });
});

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
  await expect(row).toContainText('0 次');
  await expect(row).toContainText('下次');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-scheduled.png') });

  await row.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(row).toContainText('已暂停');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-paused.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(page.locator('.connection-badge.connection-connected')).toBeVisible();
  await input.fill('/loop');
  await input.press('Enter');
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toContainText('已排程');
  await row.getByRole('button', { name: '取消循环', exact: true }).click();
  await expect(row).toContainText('已取消');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-cancelled.png') });

  await dialog.getByRole('button', { name: '新建循环', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '间隔', exact: true })).toHaveValue('5m');
  await expect(dialog.getByRole('textbox', { name: '任务', exact: true })).toBeVisible();
  await expect(dialog.getByRole('spinbutton')).toHaveCount(0);
  await dialog.screenshot({ path: join(tmpdir(), 'covro-345-loop-form.png') });
});

test('shows adaptive scheduling and completion in the session manager and the Tasks panel', async ({
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
  const row = dialog.locator('.session-loop-row');

  await input.fill('/loop 检查当前 PR 的 CI 状态，通过后结束');
  await input.press('Enter');
  await expect(row).toContainText('自适应间隔');
  await expect(row).toContainText('当前 PR 的构建仍在运行。');
  await expect(row).toContainText('构建尚未结束，五分钟后复查。');
  await expect(row).toContainText('下次');
  await expect(row).toContainText('1 次');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-386-adaptive-scheduled.png') });

  await dialog.getByRole('button', { name: '新建循环', exact: true }).click();
  await dialog.getByRole('textbox', { name: '间隔', exact: true }).clear();
  await dialog.getByRole('textbox', { name: '任务', exact: true }).fill('检查站点恢复后结束');
  await dialog.screenshot({ path: join(tmpdir(), 'covro-386-adaptive-create.png') });
  await dialog.getByRole('button', { name: '创建循环', exact: true }).click();
  const stopped = row.filter({ hasText: '检查站点恢复后结束' });
  await expect(stopped).toContainText('已完成');
  await expect(stopped).toContainText('健康检查已全部通过。');
  await expect(stopped).not.toContainText('下次');
  await expect(stopped.getByRole('button')).toHaveCount(0);

  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  const tasks = page.getByRole('dialog', { name: '后台任务', exact: true });
  await tasks.getByRole('button', { name: '循环任务', exact: true }).click();
  await expect(tasks.locator('.session-loop-row')).toHaveCount(2);
  await expect(
    tasks.locator('.session-loop-row').filter({ hasText: '检查站点恢复后结束' }),
  ).toContainText('已完成');
  await tasks.screenshot({ path: join(tmpdir(), 'covro-386-adaptive-tasks.png') });
});

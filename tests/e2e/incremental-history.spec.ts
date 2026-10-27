import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';
import type { ServerMessage } from '../../src/shared/types';

test('long history stays complete across live updates, reconnect, reload, and approval', async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90_000);
  await controlRuntime(request, { reset: true });
  const updates: ServerMessage[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ServerMessage;
      if (message.type === 'event' && message.kind === 'threadPatch') updates.push(message);
    }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[transport-history] 验证完整历史');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const ending = page.getByText('完整消息的末尾仍然可见。', { exact: true });
  await expect(ending).toBeVisible({ timeout: 30_000 });
  // Earlier files share the fixture database; its first row need not be this conversation.
  const selected = page.locator('[data-thread-id][aria-current="page"]');
  await expect(selected).toHaveCount(1);
  const id = await selected.getAttribute('data-thread-id');
  expect(id).toBeTruthy();
  const snapshot = await request.get(`/api/threads/${id}/snapshot`);
  expect(snapshot.ok()).toBe(true);
  expect((await snapshot.body()).length).toBeGreaterThan(2 * 1024 * 1024);
  updates.length = 0;
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[approval] 继续验证实时控制');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  expect(updates.length).toBeGreaterThan(0);
  expect(
    Math.max(...updates.map((message) => Buffer.byteLength(JSON.stringify(message)))),
  ).toBeLessThan(16 * 1024);
  await expect(ending).toHaveCount(1);
  await expect(page.locator('.conversation-content')).not.toContainText('内容已截断');
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.action-card')).toBeVisible();
  await page.locator('.action-options button').first().click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(ending).toHaveCount(1);
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-content')).not.toContainText('内容已截断');
  await page.locator('details.activity-group').first().locator('summary').first().click();
  const command = page.locator('details.activity').first();
  await command.locator('summary').first().click();
  await expect(command.locator('.tool-output')).toContainText('完整工具输出的末尾。');
  await ending.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/covro-285-long-history.png' });
});

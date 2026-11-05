import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

const evidence = join(tmpdir(), 'covro-313-evidence');
const prompt = '[pre-turn-compact-recover] 请检查截图，继续完善用户消息的展示。';
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});
for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: shows the prompt before submission, during pre-turn compaction and once after confirmation`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/threads/*/turns', async (route) => {
      await gate;
      await route.continue();
    });
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 300, height: 180 } });
    await page.locator('.composer-box textarea').fill(prompt);
    await page
      .locator('.composer-box input[type=file]')
      .setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const user = page.locator('.conversation-content .user-message');
    await expect(user).toHaveCount(1);
    await expect(user).toHaveAttribute('data-submission-state', 'submitting');
    await expect(page.locator('.turn')).toHaveCount(0);
    release();
    await expect(page.getByTestId('context-compaction')).toHaveAttribute(
      'data-state',
      'inProgress',
    );
    await expect(user).toHaveAttribute('data-submission-state', 'submitted');
    await expect(user.locator('.user-text')).toHaveText(prompt);
    await expect(user.locator('img')).toHaveJSProperty('naturalWidth', 300);
    const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
    const snapshot = await (await request.get(`/api/threads/${id}/snapshot`)).json();
    expect(snapshot.data.turns[0].items.map((item: { type: string }) => item.type)).toEqual([
      'contextCompaction',
    ]);
    expect(snapshot.data.pendingMessages).toHaveLength(1);
    await page.screenshot({
      path: join(evidence, `compacting-${viewport.name}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(user).toHaveCount(1);
    await expect(user.locator('.user-text')).toHaveText(prompt);
    await expect(user.locator('img')).toHaveJSProperty('naturalWidth', 300);
    await expect(page.getByTestId('context-compaction')).toHaveAttribute('data-state', 'completed');
    await expect(user).not.toHaveAttribute('data-submission-state');
    await expect(user).toHaveCount(1);
    await expect(user.locator('img')).toHaveJSProperty('naturalWidth', 300);
    await page.screenshot({
      path: join(evidence, `confirmed-${viewport.name}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(user).toHaveCount(1);
    await expect(user.locator('.user-text')).toHaveText(prompt);
  });
}

test('failure, interruption, thread switching and reconnect keep the actual submitted prompt', async ({
  page,
  context,
}) => {
  const text = '[pre-turn-compact-hold] 这条要求在压缩期间仍然可见';
  await page.locator('.composer-box textarea').fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const user = page.locator('.conversation-content .user-message');
  await expect(page.getByTestId('context-compaction')).toHaveAttribute('data-state', 'inProgress');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await expect(user.locator('.user-text')).toHaveText(text);
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await page
    .locator('[data-project-id="fixture"]')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await expect(user).toHaveCount(0);
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(user.locator('.user-text')).toHaveText(text);
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await expect(user).toHaveCount(1);
  await expect(user).not.toHaveAttribute('data-submission-state');
  await page
    .locator('.composer-box textarea')
    .fill('[pre-turn-compact-fail] 保留失败轮次的用户要求');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('失败');
  await expect(user).toHaveCount(2);
  await page.reload();
  await expect(user).toHaveCount(2);
  await expect(user.last()).toContainText('保留失败轮次的用户要求');
});

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, openModelSettings } from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test('Plan selection stays a draft until a task starts and can return to Execute', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  const input = page.locator('.composer-box textarea');
  await input.fill('/plan');
  await input.press('Enter');
  await expect(page.locator('.slash-feedback')).toContainText('下一次任务');
  expect(await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'))).toBeNull();
  await input.fill('/plan Compare the two designs');
  await input.press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const id = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  const read = async () => await (await request.get(`/api/threads/${id}`)).json();
  expect((await read()).runtimeSettings.collaborationMode).toBe('plan');
  expect(
    (await read()).turns[0].items.find((item: { type: string }) => item.type === 'userMessage')
      .text,
  ).toBe('Compare the two designs');
  await openModelSettings(page);
  await expect(page.getByRole('combobox', { name: '协作模式' })).toContainText('Plan');
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-plan-desktop.png'), fullPage: true });
  await page.getByRole('combobox', { name: '协作模式' }).click();
  await page.getByRole('option', { name: '执行', exact: true }).click();
  await page.keyboard.press('Escape');
  await input.fill('Implement it');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  expect((await read()).runtimeSettings.collaborationMode).toBe('default');
});
test('Plan mode selection and inline tasks work on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('.composer-box textarea').fill('/plan Outline a migration');
  await page.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await openModelSettings(page);
  await expect(page.getByRole('combobox', { name: '协作模式' })).toContainText('Plan');
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-plan-mobile.png'), fullPage: true });
});

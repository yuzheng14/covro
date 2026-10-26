import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';
test('goal shows real snapshots, confirms activation, persists on reload, pauses and clears', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const input = page.locator('.composer-box textarea');
  await input.fill('/goal Complete the fixture validation');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '会话目标', exact: true });
  await expect(dialog).toContainText('当前没有目标');
  await expect(dialog.getByRole('textbox', { name: '目标', exact: true })).toHaveValue(
    'Complete the fixture validation',
  );
  await dialog.getByRole('spinbutton').fill('5000');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/goal'));
  await dialog.getByRole('button', { name: '保存并激活', exact: true }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    action: 'set',
    status: 'active',
    tokenBudget: 5000,
    confirm: true,
  });
  await expect(dialog.locator('.goal-summary')).toContainText('进行中');
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-goal-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(dialog.locator('.goal-summary')).toContainText('已暂停');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expectThreadReady(page);
  await input.fill('/goooal');
  await input.press('Enter');
  await expect(dialog.locator('.goal-summary')).toContainText('已暂停');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-goal-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: '清除目标', exact: true }).click();
  await expect(dialog).toContainText('当前没有目标');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.goal-banner')).toHaveCount(0);
  await expect(page.locator('.turn')).toHaveCount(0);
});

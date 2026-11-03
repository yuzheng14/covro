import { expect, test, type Page } from '@playwright/test';
import {
  openModelSettings,
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
} from './helpers';

const longModel = 'private-provider-gpt-5-codex-with-a-very-long-version-name';
async function checkRow(page: Page) {
  const row = page.locator('.composer-actions');
  const boxes = await Promise.all(
    (await row.locator('.composer-context > *, .composer-send-controls > *').all()).map((node) =>
      node.boundingBox(),
    ),
  );
  const visible = boxes.filter((box) => box !== null);
  const centers = visible.map((box) => box!.y + box!.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
  for (let i = 1; i < visible.length; i++)
    expect(visible[i]!.x).toBeGreaterThanOrEqual(visible[i - 1]!.x + visible[i - 1]!.width);
  expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const model of ['gpt-5', longModel]) {
  test(`compact toolbar fits ${model} on desktop and narrow screens`, async ({ page, request }) => {
    await controlRuntime(request, { reset: true });
    await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), model } });
    });
    await page.goto('/');
    await confirmCompatibility(page);
    const control = page.getByRole('button', { name: '模型设置', exact: true });
    await expect(control).toContainText(model);
    await expect(page.locator('.composer-target')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '权限详情' })).toHaveCount(0);
    for (const width of [1440, 1000, 900, 760, 430, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await checkRow(page);
      expect((await control.boundingBox())!.width).toBeLessThanOrEqual(210);
      expect(
        await page
          .locator('.settings-model-toggle .settings-model-value')
          .evaluate((node) => node.scrollWidth > node.clientWidth),
      ).toBe(model === longModel);
    }
    await openModelSettings(page);
    await page.getByRole('combobox', { name: '模型', exact: true }).click();
    const menu = page.getByRole('listbox', { name: '模型', exact: true });
    expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    expect(await menu.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
  });
}

test('active controls and context ring stay on one row down to 320px', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await page.locator('.composer-box textarea').fill('[approval] 验证工具栏');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  for (const width of [1280, 960, 760, 430, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkRow(page);
    await expect(page.getByRole('button', { name: '上下文使用情况' })).toBeVisible();
    await expect(page.getByRole('button', { name: '中断', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '追加要求', exact: true })).toBeVisible();
  }
});

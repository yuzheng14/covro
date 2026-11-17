import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { supportedLocales } from '../../src/web/i18n/locales';
import { confirmCompatibility, controlRuntime, openSidebarSettings } from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
for (const locale of supportedLocales) {
  const catalog = (namespace: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/web/i18n/locales/${locale}/${namespace}.json`, 'utf8'));
  const sidebar = catalog('sidebar');
  for (const width of [1440, 390, 320]) {
    test(`${locale} ${width}px: categorized settings keep navigation and controls usable`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      await page.addInitScript((value) => localStorage.setItem('covro.locale', value), locale);
      await page.goto('/');
      await page.locator('.compatibility-dialog-actions button').last().click();
      const dialog = await openSidebarSettings(page);
      await expect(dialog.locator('.settings-nav button')).toHaveText(
        ['general', 'ai', 'account', 'service'].map((key) => sidebar[`settings_category_${key}`]!),
      );
      await expect(
        dialog.getByRole('combobox', { name: catalog('common').language }),
      ).toHaveAttribute('data-value', locale);
      await expect(
        dialog.getByRole('combobox', { name: catalog('common').appearance }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: sidebar.browser_notifications!, exact: true }),
      ).toBeVisible();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (width < 641) {
        await dialog.locator('.settings-back').click();
        await expect(dialog.locator('.settings-nav')).toBeVisible();
      }
      await dialog.locator('[data-settings-category="ai"]').click();
      await expect(
        dialog.getByRole('combobox', { name: catalog('settings').global_default_model }),
      ).toBeVisible();
      await expect(dialog.locator('.settings-nav [aria-current="page"]')).toHaveText(
        sidebar.settings_category_ai!,
      );
      if (locale === 'zh-Hans')
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme });
          const path = info.outputPath(`settings-sidebar-${theme}-${width}.png`);
          await dialog.screenshot({ path, animations: 'disabled' });
          await info.attach(`settings-sidebar-${theme}-${width}`, {
            path,
            contentType: 'image/png',
          });
        }
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('.sidebar-settings-trigger')).toBeFocused();
      await page.locator('.sidebar-settings-trigger').press('Enter');
      await expect(dialog).toBeVisible();
      if (width < 641) await dialog.locator('[data-settings-category="ai"]').click();
      await expect(
        dialog.getByRole('combobox', { name: catalog('settings').global_default_model }),
      ).toBeVisible();
      await dialog.locator('.settings-heading button').click();
    });
  }
}
for (const target of [
  { category: 'general', button: '浏览器通知', panel: '.notification-dialog' },
  { category: 'service', button: '服务配置', panel: '.gateway-dialog' },
  { category: 'service', button: '备份与恢复', panel: '.backup-dialog' },
] as const) {
  test(`${target.panel} opens inside one settings window and returns to its category`, async ({
    page,
  }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    const settings = await openSidebarSettings(page, target.category);
    await settings.getByRole('button', { name: target.button, exact: true }).click();
    await expect(settings.locator(target.panel)).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await settings.locator('.settings-back').click();
    await expect(settings.locator(target.panel)).toHaveCount(0);
    await expect(settings.getByRole('button', { name: target.button, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar-settings-trigger')).toBeFocused();
  });
}
test('switching categories and opening instructions protect unsaved defaults and instructions', async ({
  page,
}) => {
  await page.route('**/api/instructions/global', (route) =>
    route.fulfill({
      json: {
        path: '/example/AGENTS.md',
        content: 'Example instructions',
        revision: 'example',
        exists: true,
        overridden: false,
      },
    }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  const settings = await openSidebarSettings(page, 'ai');
  await settings.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await settings.locator('[data-settings-category="account"]').click();
  await expect(settings.getByRole('alert')).toContainText('放弃尚未保存');
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
    'simulated-alternative',
  );
  await settings.getByRole('button', { name: '全局指令', exact: true }).click();
  await settings.getByRole('button', { name: '放弃修改', exact: true }).click();
  const textbox = settings.getByRole('textbox', { name: 'AGENTS.md', exact: true });
  await textbox.fill('Unsaved instructions');
  await settings.locator('[data-settings-category="service"]').click();
  await expect(settings.getByRole('alert')).toContainText('放弃尚未保存');
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(textbox).toHaveValue('Unsaved instructions');
  await settings.locator('.settings-back').click();
  await settings.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '默认模型', exact: true })).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
});

test('mobile category navigation discards drafts and unmounts hidden panels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await confirmCompatibility(page);
  const settings = await openSidebarSettings(page, 'ai');
  const model = settings.getByRole('combobox', { name: '默认模型', exact: true });
  await expect(model).toContainText('simulated-model');
  await model.click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await settings.locator('.settings-back').click();
  await settings.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(settings.locator('.global-defaults-dialog')).toHaveCount(0);
  await settings.locator('[data-settings-category="ai"]').click();
  await expect(model).toContainText('simulated-model');
  await settings.locator('.settings-back').click();
  await settings.locator('[data-settings-category="account"]').click();
  await expect(settings.locator('.account-dialog')).toBeVisible();
  await settings.locator('.settings-back').click();
  await expect(settings.locator('.account-dialog')).toHaveCount(0);
});

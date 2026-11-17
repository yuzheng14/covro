import { expect, test } from '@playwright/test';
import { openSidebarSettings } from './helpers';

test('appearance follows the system and preserves explicit choices', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const compatibility = page.locator('.compatibility-dialog[open]');
  if (await compatibility.isVisible()) {
    await page.locator('.compatibility-dialog-actions button').last().click();
  }
  let settings = await openSidebarSettings(page);
  await settings.locator('.appearance-selector [role="combobox"]').click();
  await page.getByRole('option', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  settings = await openSidebarSettings(page);
  await settings.locator('.appearance-selector [role="combobox"]').click();
  await page.getByRole('option', { name: '暗色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(settings).toHaveCSS('background-color', 'rgb(36, 38, 42)');
  await expect(settings).toHaveCSS('color', 'rgb(205, 208, 213)');
  await page.screenshot({ path: 'test-results/theme-dark.png', fullPage: true });
  await settings.locator('.appearance-selector [role="combobox"]').click();
  await page.getByRole('option', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/theme-light.png', fullPage: true });
});

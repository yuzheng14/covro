import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openModelSettings,
} from './helpers';

const evidence = '/tmp/covro-context-usage';
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
});

test('context ring separates last response from cumulative tokens and supports keyboard, refresh and mobile', async ({
  page,
  context,
}) => {
  const ring = page.getByRole('button', { name: '上下文使用情况' });
  await expect(ring).toHaveAttribute('data-percent', 'unknown');
  await page.locator('.composer-box textarea').fill('[context-usage:full] 展示上下文信息');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', '25');
  await page.locator('.composer-box').screenshot({ path: `${evidence}/after-desktop.png` });
  await ring.hover();
  const hint = page.getByRole('tooltip');
  await expect(hint).toContainText('上下文 · 25%');
  await expect(hint).toContainText('50,000');
  await expect(hint).toContainText('500,000');
  await page.screenshot({ path: `${evidence}/desktop-tooltip.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await ring.focus();
  await ring.press('Enter');
  const dialog = page.getByRole('dialog', { name: '上下文与 Token' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('row', { name: '输出 2,000 20,000', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', '25');
  await expect(dialog.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await page.screenshot({ path: `${evidence}/desktop-details.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(ring).toBeFocused();
  await page.reload();
  await expect(ring).toHaveAttribute('data-percent', '25');
  await context.setOffline(true);
  await expect(ring).toHaveAttribute('data-stale', 'true');
  await ring.click();
  await expect(dialog).toContainText('上次已知用量');
  await expect(dialog.getByRole('button', { name: '刷新', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await context.setOffline(false);
  await expect(ring).toHaveAttribute('data-stale', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await ring.click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/mobile-details.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator('.composer-box').screenshot({ path: `${evidence}/mobile-composer.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await createEmptyThread(page);
  await expect(ring).toHaveAttribute('data-percent', 'unknown');
});

for (const [scenario, percent] of [
  ['zero', '0'],
  ['partial', 'unknown'],
  ['no-window', 'unknown'],
]) {
  test(`${scenario} usage stays distinct from missing data`, async ({ page }) => {
    await page.locator('.composer-box textarea').fill(`[context-usage:${scenario}] 验证字段`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    const ring = page.getByRole('button', { name: '上下文使用情况' });
    await expect(ring).toHaveAttribute('data-percent', percent!);
    await ring.click();
    const dialog = page.getByRole('dialog', { name: '上下文与 Token' });
    await expect(dialog).toContainText(scenario === 'zero' ? '0%' : '未报告');
    await page.screenshot({ path: `${evidence}/${scenario}.png`, fullPage: true });
  });
}

test('compaction and actual model changes wait for a fresh usage report', async ({
  page,
  request,
}) => {
  const ring = page.getByRole('button', { name: '上下文使用情况' });
  await page.locator('.composer-box textarea').fill('[context-usage:full] 首轮');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', '25');
  await openModelSettings(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  await expect(model).toBeEnabled();
  await model.click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  await expect(ring).toHaveAttribute('data-percent', '25'); // pending choice is not actual
  await page.locator('.composer-box textarea').fill('切换实际模型');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', 'unknown');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.locator('.composer-box textarea').fill('[context-usage:full] 新报告');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', '25');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.locator('.composer-box textarea').fill('[context-compact-hold] 压缩上下文');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring).toHaveAttribute('data-percent', 'unknown');
  await controlRuntime(request, { unavailable: true });
  await expect(ring).toHaveAttribute('data-stale', 'true');
  await expect(ring).toHaveAccessibleDescription(/上次已知用量/);
});

for (const [locale, title, recent] of [
  ['zh-Hans', '上下文与 Token', '最近调用'],
  ['en', 'Context and tokens', 'Latest call'],
  ['ja', 'コンテキストとトークン', '直近の呼び出し'],
  ['ko', '컨텍스트 및 토큰', '최근 호출'],
]) {
  test(`usage details render in ${locale} at 320px`, async ({ page }) => {
    await page.locator('.composer-box textarea').fill('[context-usage:full] locale data');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.context-usage-trigger')).toHaveAttribute('data-percent', '25');
    // A different tab's explicit language choice updates this tab in place.
    await page.evaluate((locale) => {
      localStorage.setItem('covro.locale', locale!);
      dispatchEvent(new StorageEvent('storage', { key: 'covro.locale', newValue: locale }));
    }, locale);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('.context-usage-trigger').click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(recent!);
    await expect(dialog).toContainText('50,000');
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/locale-${locale}.png`, fullPage: true });
  });
}

import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openModelSettings,
} from './helpers';

const evidence = '/tmp/covro-context-simple';
const ring = (page: Page) => page.locator('.context-usage-trigger');
async function send(page: Page, text: string) {
  await page.locator('.composer-box textarea').fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}
async function expectSymmetric(page: Page) {
  const box = (await page.locator('.composer-box').boundingBox())!;
  const first = (await page.locator('.composer-attach').boundingBox())!;
  const last = (await page.locator('.composer-submit .button').boundingBox())!;
  expect(Math.abs(first.x - box.x - (box.x + box.width - last.x - last.width))).toBeLessThanOrEqual(
    1,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
});

test('one compact context line and per-turn tokens survive refresh, disconnect and switching', async ({
  page,
  context,
}) => {
  await expect(ring(page)).toHaveAttribute('data-percent', 'unknown');
  await send(page, '[context-usage:full] 检查上下文用量与轮次统计');
  await expect(ring(page)).toHaveAttribute('data-percent', '25');
  await expect(page.locator('.turn-tokens')).toHaveText(' · 本轮 500K tokens');
  await ring(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText('上下文 50K / 200K tokens · 25%');
  await expect(page.locator('.context-usage-dialog, .context-usage-table')).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await page.reload();
  await expect(ring(page)).toHaveAttribute('data-percent', '25');
  await expect(page.locator('.turn-tokens')).toHaveText(' · 本轮 500K tokens');
  await context.setOffline(true);
  await expect(ring(page)).toHaveAttribute('data-stale', 'true');
  await expect(ring(page)).toHaveAccessibleDescription(/上次已知用量/);
  await context.setOffline(false);
  await expect(ring(page)).toHaveAttribute('data-stale', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectSymmetric(page);
  await ring(page).click();
  await expect(page.getByRole('tooltip')).toHaveText('上下文 50K / 200K tokens · 25%');
  await page.screenshot({ path: `${evidence}/mobile.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator('.composer-box').screenshot({ path: `${evidence}/mobile-composer.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await createEmptyThread(page);
  await expect(ring(page)).toHaveAttribute('data-percent', 'unknown');
});

for (const [scenario, percent, text] of [
  ['zero', '0', '0 / 200K'],
  ['partial', 'unknown', '未报告 / 200K'],
  ['no-window', 'unknown', '50K / 未报告'],
]) {
  test(`${scenario} context is distinct from missing data`, async ({ page }) => {
    await send(page, `[context-usage:${scenario}] 验证字段`);
    await expect(ring(page)).toHaveAttribute('data-percent', percent!);
    await ring(page).click();
    await expect(page.getByRole('tooltip')).toContainText(text!);
  });
}

test('actual model changes and compaction invalidate context without confusing a draft with confirmed settings', async ({
  page,
  request,
}) => {
  await send(page, '[context-usage:full] 首轮');
  await openModelSettings(page);
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  await expect(ring(page)).toHaveAttribute('data-percent', '25');
  await send(page, '切换实际模型');
  await expect(ring(page)).toHaveAttribute('data-percent', 'unknown');
  await send(page, '[context-usage:full] 新报告');
  await expect(ring(page)).toHaveAttribute('data-percent', '25');
  await page.locator('.composer-box textarea').fill('[context-compact-hold] 压缩上下文');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(ring(page)).toHaveAttribute('data-percent', 'unknown');
  await controlRuntime(request, { unavailable: true });
  await expect(ring(page)).toHaveAttribute('data-stale', 'true');
});

for (const [locale, label] of [
  ['zh-Hans', '上下文'],
  ['en', 'Context'],
  ['ja', 'コンテキスト'],
  ['ko', '컨텍스트'],
]) {
  test(`${locale}: compact numbers and equal margins from 320px to desktop`, async ({ page }) => {
    await send(page, '[context-usage:full] locale data');
    await page.evaluate((locale) => {
      localStorage.setItem('covro.locale', locale!);
      dispatchEvent(new StorageEvent('storage', { key: 'covro.locale', newValue: locale }));
    }, locale);
    for (const width of [320, 375, 390, 430, 760, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await expectSymmetric(page);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await ring(page).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('tooltip')).toContainText(`${label} 50K / 200K`);
    await page.screenshot({ path: `${evidence}/${locale}.png`, fullPage: true });
  });
}

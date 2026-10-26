import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import { createEmptyThread, confirmCompatibility, controlRuntime } from './helpers';

const speed = (page: Page) =>
  page.getByRole('button', { name: 'Fast 模式', exact: true, includeHidden: true });
async function chooseSpeed(page: Page, fast: boolean) {
  await openModelSettings(page);
  await speed(page).click();
  await expect(speed(page)).toHaveAttribute('aria-pressed', String(fast));
  await expect(speed(page).locator('svg')).toHaveAttribute('fill', fast ? 'currentColor' : 'none');
  await expect(speed(page)).toContainText('Fast 模式');
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  const sending = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/turns'),
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const body = (await sending).postDataJSON();
  await expect(speed(page)).toBeDisabled();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(speed(page)).toBeEnabled();
  return body;
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('enables and disables Fast with server confirmation, refresh and per-session isolation', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'false');
  await chooseSpeed(page, true);
  await expect(page.locator('.settings-pending')).toContainText('新建会话时生效');
  await createEmptyThread(page);
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  const first = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await send(page, '检查 Fast 模式');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-fast-on.png' });
  await page.reload();
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'true');
  await chooseSpeed(page, false);
  await expect(page.locator('.settings-pending')).toContainText(
    '速度待生效：Fast 关；当前：Fast 开',
  );
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-fast-pending.png' });
  await createEmptyThread(page);
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'false');
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(page.locator('.settings-pending')).toContainText(
    '速度待生效：Fast 关；当前：Fast 开',
  );
  expect((await send(page, '关闭 Fast')).settings).toEqual({ serviceTier: null });
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await page.reload();
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-fast-off.png' });
  await chooseSpeed(page, true);
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'false');
  await chooseSpeed(page, true);
  expect((await send(page, '再次开启 Fast')).settings).toEqual({ serviceTier: 'fast' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
    await page.getByRole('button', { name: '关闭导航', exact: true }).click();
    await openModelSettings(page);
    await expect(speed(page)).toBeVisible();
    expect(
      await page.locator('.composer-actions').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/codex-fast-mobile-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await openModelSettings(page);
  await speed(page).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Fast 开' })).toBeVisible();
  await page.screenshot({
    path: '/tmp/codex-fast-mobile-tooltip.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
});

test('reports missing and other tiers honestly, and does not offer Fast for unknown models', async ({
  page,
}) => {
  await page.route('**/runtime-settings', (route) =>
    route.fulfill({ json: { model: 'private-model', reasoningEffort: null } }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(speed(page)).toHaveAttribute('aria-pressed', 'mixed');
  await expect(speed(page)).toHaveAccessibleDescription(/Fast 未报告.*当前模型未提供 Fast/);
  await expect(speed(page)).toBeDisabled();
  await openModelSettings(page);
  await page
    .locator('.control-hint')
    .filter({ has: speed(page) })
    .hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Fast 未报告' })).toBeVisible();
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-fast-unknown.png' });
});

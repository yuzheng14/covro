import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  openSidebarSettings,
  selectInterfaceLocale,
} from './helpers';

const account = {
  account: { type: 'chatgpt', email: 'not-shown@example.test', planType: 'plus' },
  requiresOpenaiAuth: true,
};
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
const limits = {
  ordinaryUsageAllowed: true,
  accountId: 'private-id',
  rateLimits: { limitId: 'codex' },
  rateLimitsByLimitId: {
    codex: {
      limitName: 'Codex',
      planType: 'plus',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: resetsAt + 86400 },
    },
    model: {
      limitName: 'Model quota',
      normalModelSlug: 'reported-model',
      primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) - 60 },
      credits: { unlimited: true },
    },
  },
};
async function openUsage(page: Page, label = '账户额度') {
  const settings = await openSidebarSettings(page);
  await settings.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.locator('.account-dialog[open]');
  await expect(dialog).toBeVisible();
  return dialog;
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true, accountUsage: { account, limits } });
});

test('reads native quota groups, refreshes rolling updates, and shows reset expiry without restoring quota', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const dialog = await openUsage(page);
  await expect(dialog.getByRole('region', { name: 'Codex', exact: true })).toContainText(
    '已用 25%',
  );
  await expect(dialog.getByRole('region', { name: 'Model quota', exact: true })).toContainText(
    '无限额度',
  );
  await expect(dialog).toContainText('额度已耗尽');
  await expect(dialog).toContainText('重置时间已过，请刷新确认当前额度');
  await expect(dialog).toContainText('数据时间：');
  await expect(dialog).not.toContainText('not-shown@example.test');
  await expect(dialog).not.toContainText('private-id');
  const read = await request.get('/api/account/usage');
  expect(read.headers()['cache-control']).toBe('no-store');
  expect(JSON.stringify(await read.json())).not.toMatch(/private-id|not-shown/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '/tmp/covro-267-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/covro-267-narrow.png', fullPage: true });
  await controlRuntime(request, {
    accountUsage: {
      account,
      notification: 'limits',
      limits: {
        ...limits,
        rateLimitsByLimitId: {
          ...limits.rateLimitsByLimitId,
          codex: { limitName: 'Codex', primary: { usedPercent: 37 } },
        },
      },
    },
  });
  await expect(dialog.getByRole('region', { name: 'Codex', exact: true })).toContainText(
    '已用 37%',
  );
  await expect(dialog).toContainText('未报告重置时间');
  await expect(dialog.getByRole('region', { name: 'Model quota', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('preserves timestamp on quota failure, hides sensitive diagnostics and clears on account switch', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const dialog = await openUsage(page);
  await expect(dialog).toContainText('已用 25%');
  await controlRuntime(request, {
    accountUsage: { account, notification: 'limits', failure: true },
  });
  await expect(dialog).toContainText('刷新失败');
  await expect(dialog).toContainText('已用 25%');
  await expect(dialog).not.toContainText('Private upstream');
  await page.screenshot({ path: '/tmp/covro-267-refresh-failed.png', fullPage: true });
  await controlRuntime(request, {
    accountUsage: {
      account: {
        account: { type: 'chatgpt', email: null, planType: 'pro' },
        requiresOpenaiAuth: true,
      },
      limits: { rateLimits: { limitName: 'New account' } },
    },
  });
  await expect(dialog).toContainText('New account');
  await expect(dialog).not.toContainText('已用 25%');
  await expect(dialog).not.toContainText('Model quota');
  await controlRuntime(request, { unavailable: true });
  await expect(dialog).toContainText('Codex 已离线');
  await expect(dialog).not.toContainText('New account');
  await expect(dialog.getByRole('button', { name: '刷新', exact: true })).toBeDisabled();
  await controlRuntime(request, { unavailable: false });
  await expect(dialog).toContainText('New account');
});

test('handles signed-out, unsupported, empty, missing fields and zero credits', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const dialog = await openUsage(page);
  for (const [value, message] of [
    [{ account: { account: null, requiresOpenaiAuth: true } }, 'Codex 尚未登录。'],
    [
      { account: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } },
      '此账户或 Codex 实例不提供额度信息。',
    ],
    [{ account, limits: {} }, '未报告额度窗口。'],
    [
      {
        account,
        limits: {
          rateLimits: {
            primary: {},
            credits: { balance: '0', hasCredits: false, unlimited: false },
          },
        },
      },
      '无可用 credits',
    ],
  ] as const) {
    await controlRuntime(request, { accountUsage: value });
    await expect(dialog).toContainText(message);
    await expect(dialog).not.toContainText('已用 25%');
  }
  await expect(dialog).toContainText('未报告使用比例');
  await expect(dialog).toContainText('未报告重置时间');
  await expect(dialog).toContainText('余额：0');
  await controlRuntime(request, { reset: true, accountUsage: { account, unsupported: true } });
  await expect(dialog).toContainText('此账户或 Codex 实例不提供额度信息。');
});

for (const [locale, title, used] of [
  ['en', 'Account usage', '25% used'],
  ['ja', 'アカウント使用量', '使用済み 25%'],
  ['ko', '계정 사용량', '25% 사용'],
  ['zh-Hans', '账户额度', '已用 25%'],
])
  test(`${locale}: keyboard navigation and narrow layout`, async ({ page }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await selectInterfaceLocale(page, locale!);
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = await openSidebarSettings(page);
    const entry = settings.getByRole('button', { name: title, exact: true });
    await entry.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('.account-dialog[open]');
    await expect(dialog).toContainText(used!);
    await expect(dialog).not.toContainText('account:');
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

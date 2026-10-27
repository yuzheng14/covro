import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, selectInterfaceLocale } from './helpers';
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test('browses and searches duplicate names, raw descriptions and paths on desktop and narrow screens', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '技能', exact: true });
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
  await dialog.locator('.skills-list summary').first().click();
  await expect(dialog).toContainText('Review changes and report actionable findings.');
  await dialog.getByRole('searchbox').fill('/repo/');
  await expect(dialog.locator('.skills-list li')).toHaveCount(1);
  await dialog.getByRole('searchbox').fill('not-a-skill');
  await expect(dialog).toContainText('没有匹配的技能');
  await dialog.getByRole('searchbox').fill('');
  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
  await dialog.locator('.skills-list summary').first().click();
  await page.screenshot({ path: 'test-results/skills-browser-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/skills-browser-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
test('shows discovery errors, empty catalogs and read failures with refresh recovery', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await page.route('**/api/skills/list', (route) =>
    route.fulfill({
      json: {
        cwd: '/test',
        skills: [],
        errors: [{ path: '/broken/SKILL.md', message: 'invalid metadata' }],
      },
    }),
  );
  await page.getByRole('button', { name: '技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '技能', exact: true });
  await expect(dialog).toContainText('部分技能发现失败');
  await expect(dialog).toContainText('未发现技能');
  await page.unroute('**/api/skills/list');
  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
});

for (const [locale, title, search] of [
  ['en', 'Skills', 'Search skills'],
  ['ja', 'スキル', 'スキルを検索'],
  ['ko', '스킬', '스킬 검색'],
]) {
  test(`localizes skill controls in ${locale} without translating skill content`, async ({
    page,
  }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await selectInterfaceLocale(page, locale!);
    await page.getByRole('button', { name: title!, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title!, exact: true });
    await expect(dialog.getByRole('searchbox', { name: search! })).toBeVisible();
    await expect(dialog.locator('.skills-list li')).toHaveCount(2);
    await dialog.locator('.skills-list summary').first().click();
    await expect(dialog).toContainText('Review changes and report actionable findings.');
  });
}

test('read failures, Codex unavailability and offline catalogs expose accurate recovery states', async ({
  page,
  request,
  context,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await page.route('**/api/skills/list', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'SKILLS_READ_FAILED', message: 'fixture read failure' } },
    }),
  );
  await page.getByRole('button', { name: '技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '技能', exact: true });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/skills/list');
  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
  await controlRuntime(request, { unavailable: true });
  await expect(dialog).toContainText('Codex 尚未就绪');
  await expect(dialog.locator('.skills-list li')).toHaveCount(0);
  await controlRuntime(request, { unavailable: false });
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
  await context.setOffline(true);
  await expect(dialog).toContainText('当前离线');
  await context.setOffline(false);
  await expect(dialog.locator('.skills-list li')).toHaveCount(2);
});

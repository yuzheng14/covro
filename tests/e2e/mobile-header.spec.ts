import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  chooseSelectOption,
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openSidebarSettings,
  saveConversationHistory,
  testOrigin,
} from './helpers';

const more = (page: Page) => page.getByRole('button', { name: '更多操作', exact: true });
const toolbar = (page: Page) => page.locator('.topbar-tools');
const diagnostics = (page: Page) => page.getByRole('region', { name: '状态诊断详情', exact: true });

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
});

test('compact tools keep keyboard order and restore focus after dismissal and dialogs', async ({
  page,
}) => {
  const header = page.locator('.topbar');
  const desktopHeight = (await header.boundingBox())!.height;
  await expect(more(page)).toHaveCount(0);
  await expect(toolbar(page).getByRole('button', { name: '后台任务' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(more(page)).toBeVisible();
  await expect(toolbar(page)).not.toBeVisible();
  await expect(header.locator('.connection-badge')).not.toBeVisible();
  const closedHeight = (await header.boundingBox())!.height;
  expect(closedHeight).toBeLessThan(desktopHeight);
  expect((await more(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await more(page).focus();
  await page.keyboard.press('Enter');
  await expect(toolbar(page)).toBeVisible();
  expect((await header.boundingBox())!.height).toBe(closedHeight);
  const taskButton = toolbar(page).getByRole('button', { name: '后台任务' });
  await page.keyboard.press('Tab');
  await expect(taskButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toolbar(page)).not.toBeVisible();
  await expect(more(page)).toBeFocused();

  for (const name of ['后台任务', '开发预览', '技能']) {
    await more(page).click();
    await toolbar(page).getByRole('button', { name, exact: true }).click();
    await expect(toolbar(page)).not.toBeVisible();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(more(page)).toBeFocused();
  }
  await more(page).click();
  await toolbar(page).getByRole('button', { name: '打开 Shell 面板', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Shell 面板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭 Shell 面板', exact: true }).click();

  await more(page).click();
  await toolbar(page).getByRole('button', { name: '状态诊断', exact: true }).click();
  await expect(diagnostics(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(diagnostics(page)).not.toBeVisible();
  await expect(more(page)).toBeFocused();

  await more(page).click();
  await page.locator('.demo-banner').click({ position: { x: 8, y: 8 } });
  await expect(toolbar(page)).not.toBeVisible();
  await more(page).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(more(page)).toHaveCount(0);
  await expect(taskButton).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toolbar(page)).not.toBeVisible();
});

test('an open compact menu follows app and system appearance without losing keyboard focus', async ({
  page,
  context,
}) => {
  const peer = await context.newPage();
  await peer.goto('/');
  const settings = await openSidebarSettings(peer);
  const appearance = settings.getByRole('combobox', { name: '外观', exact: true });

  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await more(page).press('Enter');
  const menu = toolbar(page);
  const task = menu.getByRole('button', { name: '后台任务', exact: true });
  await page.keyboard.press('Tab');
  await expect(task).toBeFocused();
  await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(task).toHaveCSS('outline-color', 'rgb(19, 118, 93)');

  await chooseSelectOption(peer, appearance, '暗色');
  await expect(menu).toBeVisible();
  await expect(task).toBeFocused();
  await expect(menu).toHaveCSS('background-color', 'rgb(41, 44, 49)');
  await expect(menu).toHaveCSS('border-color', 'rgb(58, 62, 69)');
  await expect(task).toHaveCSS('color', 'rgb(205, 208, 213)');
  await expect(task.locator('svg')).toHaveCSS('stroke', 'rgb(205, 208, 213)');
  await expect(task).toHaveCSS('outline-color', 'rgb(138, 183, 161)');
  await task.hover();
  await expect(task).toHaveCSS('background-color', 'rgb(48, 52, 58)');

  const shell = menu.getByRole('button', { name: '打开 Shell 面板', exact: true });
  await shell.click();
  await more(page).click();
  await expect(shell).toHaveAttribute('aria-expanded', 'true');
  await expect(shell).toHaveCSS('background-color', 'rgb(41, 59, 51)');
  await expect(shell).toHaveCSS('color', 'rgb(138, 183, 161)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await chooseSelectOption(peer, appearance, '浅色');
  await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(shell).toHaveCSS('background-color', 'rgb(234, 244, 239)');
  await chooseSelectOption(peer, appearance, '跟随系统');
  await expect(menu).toHaveCSS('background-color', 'rgb(41, 44, 49)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await more(page).click();
  await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('intermediate viewports fit the header with a long title and preserve focus through resize', async ({
  page,
}) => {
  await saveConversationHistory(page);
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const title = 'Accessibility and internationalization review for the workspace activity feed';
  const rename = await page.request.post(`/api/threads/${id}/rename`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), name: title },
  });
  expect(rename.ok()).toBe(true);
  await page.route('**/github-repository', (route) =>
    route.fulfill({ json: { url: 'https://github.com/example/design-system' } }),
  );

  const header = page.locator('.topbar');
  const titleControl = header.getByRole('button', { name: '重命名会话', exact: true });
  const repository = header.getByRole('link', { name: '打开 GitHub 仓库' });
  const task = toolbar(page).getByRole('button', { name: '后台任务', exact: true });
  for (const [locale, label] of [
    ['en', 'More actions'],
    ['ja', 'その他の操作'],
    ['ko', '추가 작업'],
    ['zh-Hans', '更多操作'],
  ]) {
    await page.evaluate((locale) => localStorage.setItem('covro.locale', locale!), locale);
    await page.reload();
    await expect(header.locator('h1')).toHaveText(title);
    await expect(
      header.locator('a[href="https://github.com/example/design-system"]'),
    ).toBeVisible();
    for (const width of [760, 761, 762, 964, 965, 966]) {
      await page.setViewportSize({ width, height: 844 });
      const trigger = header.getByRole('button', { name: label, exact: true });
      if (width <= 762) await expect(trigger).toBeVisible();
      await expect
        .poll(() =>
          header.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const title = element.querySelector('.topbar-title')!.getBoundingClientRect();
            const status = element.querySelector('.topbar-status')!.getBoundingClientRect();
            return (
              title.right <= status.left &&
              status.right <= bounds.right &&
              element.scrollWidth === element.clientWidth &&
              document.documentElement.scrollWidth === innerWidth &&
              title.top < status.bottom &&
              status.top < title.bottom
            );
          }),
        )
        .toBe(true);
      expect(await page.evaluate(() => innerWidth)).toBe(width);
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(task).toBeVisible();
  await task.focus();
  await page.setViewportSize({ width: 761, height: 844 });
  await expect(more(page)).toBeFocused();
  await expect(repository).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(task).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(task).toBeFocused();
  await expect(more(page)).toHaveCount(0);
  await page.setViewportSize({ width: 761, height: 844 });
  await expect(toolbar(page)).not.toBeVisible();
  await titleControl.click();
  await expect(header.getByRole('textbox', { name: '会话名称' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(titleControl).toBeFocused();

  await page.setViewportSize({ width: 760, height: 844 });
  await header.getByRole('button', { name: '打开项目与会话' }).click();
  await expect(page.locator('.sidebar-open')).toBeVisible();
  await page.setViewportSize({ width: 761, height: 844 });
  await expect(page.locator('.sidebar-open')).toHaveCount(0);
  await expect(more(page)).toBeVisible();
});

test('pending approvals and several unresolved operations stay visible through disconnect', async ({
  page,
  request,
  context,
}) => {
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  expect(id).toBeTruthy();
  const response = await request.post(`/api/threads/${id}/turns`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), text: '[approval] Check the release' },
  });
  expect(response.ok()).toBe(true);
  await expect(page.locator('.action-card')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 650 });
  await expect(page.locator('.topbar-attention .status-waitingApproval')).toBeVisible();

  // Exercise the same browser journal used for uncertain receipts after a page reload.
  await page.evaluate((id) => {
    const records = Array.from({ length: 12 }, () => ({
      clientOperationId: crypto.randomUUID(),
      kind: 'steer',
      target: id,
      createdAt: Date.now(),
    }));
    localStorage.setItem('codex-web.operations.v1', JSON.stringify(records));
  }, id);
  await page.reload();
  const alert = page.getByRole('button', { name: /^状态诊断（1[2-9]）$/ });
  await expect(alert).toBeVisible();
  await expect(page.locator('.thread-title-trigger')).toBeVisible();
  await expect(page.locator('.topbar-attention .status-waitingApproval')).toBeVisible();
  await context.setOffline(true);
  await expect(page.locator('.connection-banner')).toBeVisible();
  await expect(page.locator('.topbar-attention .status-waitingApproval')).toBeVisible();
  await alert.click();
  await expect(diagnostics(page)).toBeFocused();
  expect(await diagnostics(page).locator('.operation-card').count()).toBeGreaterThanOrEqual(12);
  const bounds = (await diagnostics(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(650);
  await page.keyboard.press('Escape');
  await expect(alert).toBeFocused();
  await context.setOffline(false);
  await expect(page.locator('.connection-banner')).not.toBeVisible();
});

test.describe('touch viewports', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('keeps the compact header in phone landscape and fits long labels in all four locales', async ({
    page,
    request,
  }) => {
    await saveConversationHistory(page);
    const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
    const title = 'AccessibilityAndInternationalizationReviewOfTheActivityFeed'
      .repeat(2)
      .slice(0, 96);
    for (const [path, data] of [
      [
        '/api/projects/fixture/rename',
        { name: 'Design Systems and International Product Infrastructure' },
      ],
      [`/api/threads/${id}/rename`, { clientOperationId: randomUUID(), name: title }],
    ] as const) {
      expect((await request.post(path, { headers: { Origin: testOrigin }, data })).ok()).toBe(true);
    }
    await page.setViewportSize({ width: 320, height: 650 });
    for (const [locale, label] of [
      ['en', 'More actions'],
      ['ja', 'その他の操作'],
      ['ko', '추가 작업'],
      ['zh-Hans', '更多操作'],
    ]) {
      await page.evaluate((locale) => localStorage.setItem('covro.locale', locale), locale!);
      await page.reload();
      await expect(page.locator('.topbar h1')).toHaveText(title);
      await expect(page.locator('.breadcrumb-project')).toHaveText(
        'Design Systems and International Product Infrastructure',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      const trigger = page.getByRole('button', { name: label, exact: true });
      await expect(trigger).toBeVisible();
      await trigger.tap();
      await expect(toolbar(page)).toBeVisible();
      const box = (await toolbar(page).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      await page.keyboard.press('Escape');
    }

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(more(page)).toBeVisible();
    await page.getByRole('button', { name: '打开项目与会话', exact: true }).tap();
    await expect(page.locator('.sidebar-open')).toBeVisible();
    await page.locator('.sidebar-open .brand .mobile-only').tap();
    await expect(page.locator('.sidebar-open')).toHaveCount(0);
    await more(page).tap();
    await expect(toolbar(page)).toBeVisible();
    const box = (await toolbar(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(390);
  });
});

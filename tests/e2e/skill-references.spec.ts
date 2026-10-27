import { devices, expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  projectGroup,
  selectInterfaceLocale,
  createEmptyThread,
} from './helpers';
const input = (page: Page) => page.locator('.composer-box textarea');
async function choose(page: Page, index = 0) {
  await input(page).fill('');
  await input(page).fill('$review');
  const options = page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option');
  await expect(options).toHaveCount(2);
  await options.nth(index).click();
  await expect(page.getByRole('list', { name: '已选技能' })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test('submits exact skill identity on first and existing messages while preserving active drafts', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, 1);
  await input(page).pressSequentially('[approval] check');
  const selectedPath = await page.locator('.composer-skills .skills-path').textContent();
  await page.screenshot({ path: testInfo.outputPath('skill-reference-desktop.png') });
  const started = page.waitForRequest((r) => /\/turns$/.test(r.url()) && r.method() === 'POST');
  await input(page).press('Enter');
  const start = (await started).postDataJSON();
  expect(start.text).toBe('$review-code [approval] check');
  expect(start.skills).toEqual([
    { name: 'review-code', path: selectedPath, cwd: start.skills[0].cwd },
  ]);
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(input(page)).toHaveValue('');
  await choose(page, 0);
  await input(page).pressSequentially('continue');
  await expect(page.getByRole('button', { name: '追加要求', exact: true })).toBeDisabled();
  await expect(page.locator('.composer-region')).toContainText('请等待当前任务结束');
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  const continued = page.waitForRequest(
    (request) => /\/turns$/.test(request.url()) && request.method() === 'POST',
  );
  await input(page).press('Enter');
  expect((await continued).postDataJSON().skills[0].path).toContain('/repo/SKILL.md');
  await expect(input(page)).toHaveValue('');
});
test('isolates project and conversation drafts and removes both marker and identity', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page);
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.composer-skills')).toHaveCount(0);
  await choose(page, 1);
  await projectGroup(page).getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(input(page)).toHaveValue('$review-code ');
  await expect(page.locator('.composer-skills .skills-path')).toContainText(
    '/project/repo/SKILL.md',
  );
  await page.getByRole('button', { name: '移除 review-code', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.composer-skills')).toHaveCount(0);
});
test('uses the reserved unassigned cwd for first-message references', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await projectGroup(page, '未关联项目')
    .getByRole('button', { name: '新建会话（无需项目）', exact: true })
    .click();
  await choose(page);
  await input(page).pressSequentially('check');
  const selected = await page.locator('.composer-skills .skills-path').textContent();
  const started = page.waitForRequest((r) => /\/turns$/.test(r.url()) && r.method() === 'POST');
  await input(page).press('Enter');
  const request = await started;
  expect(request.postDataJSON().skills[0].path).toBe(selected);
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.user-text')).toContainText('$review-code check');
});
test('literal dollars, cancellation, token edits and a failed send retain editable drafts', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('cost $100 and a$b');
  await expect(page.locator('.skill-reference-menu')).toHaveCount(0);
  await input(page).fill('$review');
  await expect(page.locator('.skill-reference-menu')).toBeVisible();
  await input(page).press('Escape');
  await expect(page.locator('.skill-reference-menu')).toHaveCount(0);
  await expect(input(page)).toHaveValue('$review');
  await choose(page);
  await input(page).pressSequentially('check');
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'SKILL_UNAVAILABLE', message: 'disabled' } },
    }),
  );
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('$review-code check');
  await expect(page.locator('.composer-skills')).toHaveCount(1);
  await input(page).fill('$review-code-edited check');
  await expect(page.locator('.composer-skills')).toHaveCount(0);
});
for (const [locale, title] of [
  ['en', 'Skills'],
  ['ja', 'スキル'],
  ['ko', '스킬'],
])
  test(`localizes reference options in ${locale}`, async ({ page }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await selectInterfaceLocale(page, locale!);
    await input(page).fill('$review');
    await expect(
      page.getByRole('listbox', { name: title!, exact: true }).getByRole('option'),
    ).toHaveCount(2);
  });
test.describe('touch', () => {
  test.use({
    viewport: devices['iPhone 13'].viewport,
    userAgent: devices['iPhone 13'].userAgent,
    isMobile: true,
    hasTouch: true,
  });
  test('selects by touch and submits with the mobile button while Enter stays a newline', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await choose(page, 1);
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('$review-code \n');
    await page.screenshot({ path: testInfo.outputPath('skill-reference-mobile.png') });
    const started = page.waitForRequest((r) => /\/turns$/.test(r.url()) && r.method() === 'POST');
    await page.getByRole('button', { name: '发送任务', exact: true }).tap();
    expect((await started).postDataJSON().skills[0].path).toContain('/user/SKILL.md');
    await expect(input(page)).toHaveValue('');
  });
});

test('keyboard selection and repeated-name deletion preserve the remaining exact identity', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('$review');
  await expect(
    page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option'),
  ).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('reference-candidates.png') });
  await input(page).press('Enter');
  await input(page).pressSequentially('$review');
  await expect(
    page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option'),
  ).toHaveCount(2);
  await input(page).press('ArrowDown');
  await input(page).press('Tab');
  await expect(page.locator('.composer-skills li')).toHaveCount(2);
  await input(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 13));
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('$review-code ');
  await expect(page.locator('.composer-skills li')).toHaveCount(1);
  await expect(page.locator('.composer-skills .skills-path')).toContainText('/user/SKILL.md');
});
test('an uncertain reference send retains its draft and is never automatically submitted twice', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await choose(page);
  await input(page).pressSequentially('check');
  let count = 0;
  await page.route('**/api/threads/*/turns', async (route) => {
    count++;
    await route.abort('failed');
  });
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('$review-code check');
  await expect(page.locator('.composer-skills li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await input(page).press('Enter');
  expect(count).toBe(1);
});
test('skill identity survives image attachments and IME confirmation', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page);
  await page.locator('.composer-box input[type=file]').setInputFiles({
    name: 'probe.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA6sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  const sent: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/turns$/.test(request.url()))
      sent.push(request.postDataJSON());
  });
  await input(page).dispatchEvent('compositionstart');
  await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await input(page).evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(sent).toHaveLength(0);
  await input(page).dispatchEvent('compositionend');
  await input(page).pressSequentially('check');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    text: '$review-code check',
    skills: [{ name: 'review-code' }],
    images: [expect.stringMatching(/^data:image\/png/)],
  });
});

test('a late catalog from another workspace cannot supply reference candidates', async ({
  page,
}) => {
  let resolveHeld!: (route: import('@playwright/test').Route) => void;
  const held = new Promise<import('@playwright/test').Route>((resolve) => {
    resolveHeld = resolve;
  });
  let captured = false;
  await page.route('**/api/skills/list', async (route) => {
    if (!captured && route.request().postDataJSON().projectId === 'fixture') {
      captured = true;
      resolveHeld(route);
      return;
    }
    await route.fallback();
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('$review');
  const old = await held;
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await input(page).fill('$review');
  const options = page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('/other-project/');
  await old
    .fulfill({
      json: {
        cwd: '/old',
        skills: [
          {
            name: 'review-old',
            path: '/old/SKILL.md',
            scope: 'repo',
            enabled: true,
            description: 'late',
            pluginId: null,
          },
        ],
        errors: [],
      },
    })
    .catch(() => {});
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('/other-project/');
  await expect(page.locator('.skill-reference-menu')).not.toContainText('review-old');
});

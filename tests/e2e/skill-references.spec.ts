import { devices, expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  projectGroup,
  selectInterfaceLocale,
  createEmptyThread,
} from './helpers';
const input = (page: Page) => page.locator('.composer-box textarea');
const selectedSkills = (page: Page) => page.locator('.composer-highlights mark');
async function choose(page: Page, index = 0) {
  await input(page).fill('');
  await input(page).fill('$review');
  const options = page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option');
  await expect(options).toHaveCount(2);
  await options.nth(index).click();
  await expect(selectedSkills(page)).toHaveCount(1);
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
  const selectedPath = await selectedSkills(page).getAttribute('data-skill-path');
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
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
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
  await expect(selectedSkills(page)).toHaveCount(0);
  await choose(page, 1);
  await projectGroup(page).getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(input(page)).toHaveValue('$review-code ');
  await expect(selectedSkills(page)).toHaveAttribute(
    'data-skill-path',
    /\/project\/repo\/SKILL.md$/u,
  );
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('');
  await expect(selectedSkills(page)).toHaveCount(0);
});
test('uses the reserved unassigned cwd for first-message references', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await projectGroup(page, '未关联项目')
    .getByRole('button', { name: '新建会话（无需项目）', exact: true })
    .click();
  await choose(page);
  await input(page).pressSequentially('check');
  const selected = await selectedSkills(page).getAttribute('data-skill-path');
  const started = page.waitForRequest((r) => /\/turns$/.test(r.url()) && r.method() === 'POST');
  await input(page).press('Enter');
  const request = await started;
  expect(request.postDataJSON().skills[0].path).toBe(selected);
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.user-text')).toContainText('$review-code check');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
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
  await expect(selectedSkills(page)).toHaveCount(1);
  await input(page).fill('$review-code-edited check');
  await expect(selectedSkills(page)).toHaveCount(0);
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
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
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
  await expect(selectedSkills(page)).toHaveCount(2);
  await input(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 13));
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('$review-code ');
  await expect(selectedSkills(page)).toHaveCount(1);
  await expect(selectedSkills(page)).toHaveAttribute('data-skill-path', /\/user\/SKILL.md$/u);
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
  await expect(selectedSkills(page)).toHaveCount(1);
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
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
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
  await expect(options.first()).toHaveAccessibleName(/\/other-project\//u);
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
  await expect(options.first()).toHaveAccessibleName(/\/other-project\//u);
  await expect(page.locator('.skill-reference-menu')).not.toContainText('review-old');
});

test('fixture reset isolates active native skill submissions from subsequent test cases', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page);
  await input(page).pressSequentially('[approval] reset isolation');
  await input(page).press('Enter');
  await expect(page.locator('.action-card')).toBeVisible();
  await controlRuntime(request, { reset: true });
  const projects = await request.get('/api/threads?projectId=fixture');
  expect((await projects.json()).data).toEqual([]);
  const unassigned = await request.get('/api/unassigned/threads');
  expect((await unassigned.json()).data).toEqual([]);
});

test('compact sources distinguish same-name same-scope skills and retain the full path in inline references', async ({
  page,
}) => {
  const paths = ['team-a', 'team-b'].map((team) => `/homes/${team}/.codex/skills/review/SKILL.md`);
  await page.route('**/api/skills/list', (route) =>
    route.fulfill({
      json: {
        cwd: '/project',
        errors: [],
        skills: paths.map((path) => ({
          name: 'review-code',
          description: 'Review changes.',
          path,
          scope: 'user',
          enabled: true,
          pluginId: null,
        })),
      },
    }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('$review');
  const options = page.getByRole('listbox', { name: '技能', exact: true }).getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('team-a');
  await expect(options.nth(1)).toContainText('team-b');
  await expect(options.nth(1)).toHaveAccessibleName(new RegExp(paths[1]!));
  await options.nth(1).click();
  await expect(selectedSkills(page)).toHaveAttribute('data-skill-path', paths[1]!);
  await expect(input(page)).toHaveAccessibleDescription(new RegExp(paths[1]!));
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('');
});

for (const width of [1280, 390])
  test(`inline references delete as a unit without extra chips at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await confirmCompatibility(page);
    await choose(page);
    await expect(page.locator('.composer-skills')).toHaveCount(0);
    await input(page).press('Backspace');
    await expect(input(page)).toHaveValue('');
    await expect(selectedSkills(page)).toHaveCount(0);
    await choose(page, 1);
    await input(page).pressSequentially('检查本次修改');
    await input(page).press('Home');
    await input(page).press('ArrowRight');
    expect(
      await input(page).evaluate((element: HTMLTextAreaElement) => element.selectionStart),
    ).toBe(12);
    await page.screenshot({ path: testInfo.outputPath(`inline-skill-${width}.png`) });
    await input(page).press('Home');
    await input(page).press('Delete');
    await expect(input(page)).toHaveValue('检查本次修改');
    await expect(selectedSkills(page)).toHaveCount(0);
  });

test('native beforeinput without a desktop keydown removes the full bound skill', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, 1);
  const selection = await input(page).evaluate((element: HTMLTextAreaElement) => {
    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
      }),
    );
    const range = [element.selectionStart, element.selectionEnd];
    element.setRangeText('', element.selectionStart, element.selectionEnd, 'end');
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
    );
    return range;
  });
  expect(selection).toEqual([0, 13]);
  await expect(input(page)).toHaveValue('');
  await expect(selectedSkills(page)).toHaveCount(0);
});

test('native undo restores the exact selected skill after one-step deletion', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, 1);
  const path = await selectedSkills(page).getAttribute('data-skill-path');
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('');
  await expect(selectedSkills(page)).toHaveCount(0);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('$review-code ');
  await expect(selectedSkills(page)).toHaveAttribute('data-skill-path', path!);
});

test('undo after a project switch restores only that project’s selected identity', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page, 0);
  const originalPath = await selectedSkills(page).getAttribute('data-skill-path');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await choose(page, 1);
  const currentPath = await selectedSkills(page).getAttribute('data-skill-path');
  expect(currentPath).toContain('/other-project/user/SKILL.md');
  await input(page).press('Backspace');
  await input(page).press('ControlOrMeta+z');
  await expect(selectedSkills(page)).toHaveAttribute('data-skill-path', currentPath!);
  await projectGroup(page).getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(selectedSkills(page)).toHaveAttribute('data-skill-path', originalPath!);
});

test('cancelling composition by switching drafts does not disable atomic deletion', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await choose(page);
  await input(page).dispatchEvent('compositionstart', { data: '' });
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await choose(page, 1);
  await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('');
  await expect(selectedSkills(page)).toHaveCount(0);
});

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  selectInterfaceLocale,
  projectGroup,
  testOrigin,
} from './helpers';

const editor = (page: Page) => page.locator('.composer-editor textarea');
const menu = (page: Page) => page.locator('.file-reference-menu');
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
}
async function choose(page: Page, query: string, path: string) {
  const input = editor(page);
  await input.press('End');
  await input.pressSequentially(query);
  await expect(menu(page).getByRole('option', { name: path, exact: false })).toBeVisible();
  await menu(page).getByRole('option', { name: path, exact: false }).click();
  await expect(page.locator(`mark[data-file-path="${path}"]`)).toHaveCount(1);
}

test('unassigned first-message selection keeps its reserved cwd through creation and submission', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '新建会话（无需项目）', exact: true }).click();
  const response = page.waitForResponse((response) => response.url().endsWith('/api/files/search'));
  await editor(page).fill('@probe');
  const search = await response;
  const { cwd } = await search.json();
  const draftId = search.request().postDataJSON().draftId;
  await writeFile(join(cwd, 'probe.txt'), 'unassigned fixture');
  await menu(page).getByRole('button', { name: '重新加载' }).click();
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await editor(page).press('Tab');
  const creation = page.waitForRequest(
    (request) => request.url().endsWith('/api/unassigned/threads') && request.method() === 'POST',
  );
  const outgoing = page.waitForRequest(
    (request) => /\/threads\/[^/]+\/turns$/.test(request.url()) && request.method() === 'POST',
  );
  await page.locator('.composer-submit button').click();
  expect((await creation).postDataJSON().clientOperationId).toBe(draftId);
  const sent = await outgoing;
  const id = new URL(sent.url()).pathname.split('/')[3]!;
  await expect(editor(page)).toHaveValue('');
  const thread = await (await request.get(`/api/threads/${id}`)).json();
  expect(thread.cwd).toBe(cwd);
  expect(thread.projectId).toBeNull();
  expect(
    thread.turns.at(-1).items.find((item: { type: string }) => item.type === 'userMessage').text,
  ).toBe('probe.txt ');
});

for (const [locale, title] of [
  ['en', 'Workspace files'],
  ['zh-Hans', '工作区文件'],
  ['ja', 'ワークスペースのファイル'],
  ['ko', '작업 공간 파일'],
]) {
  test(`real page file selection, narrow layout and localized states: ${locale}`, async ({
    page,
  }) => {
    await open(page);
    if (locale !== 'zh-Hans') await selectInterfaceLocale(page, locale!);
    const input = editor(page);
    await input.fill('Read @same');
    await expect(menu(page).getByRole('listbox', { name: title! })).toBeVisible();
    await expect(menu(page).getByRole('option')).toHaveCount(2);
    await page.screenshot({
      animations: 'disabled',
      path: `test-results/files-${locale}-desktop.png`,
    });
    await input.press('ArrowDown');
    await input.press('Tab');
    await expect(input).toHaveValue('Read @b/same.ts ');
    await choose(page, '@"docs/中文 ', 'docs/中文 说明.md');
    await input.pressSequentially('$review-code');
    await expect(page.locator('.skill-reference-menu').getByRole('option')).toHaveCount(2);
    await input.press('Enter');
    await expect(page.locator('mark[data-skill-path]')).toHaveCount(1);
    await expect(page.locator('mark[data-file-path]')).toHaveCount(2);
    await input.pressSequentially('@same');
    await expect(menu(page).getByRole('option')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await menu(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      animations: 'disabled',
      path: `test-results/files-${locale}-narrow.png`,
    });
    await input.press('Escape');
    await expect(menu(page)).toHaveCount(0);
  });
}

test('native deletion and undo preserve file identity, and file-only active steering uses path text', async ({
  page,
  request,
}) => {
  await open(page);
  const input = editor(page);
  await choose(page, '@same', 'b/same.ts');
  await input.press('Backspace');
  await expect(input).toHaveValue('');
  await expect(page.locator('mark[data-file-path]')).toHaveCount(0);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('@b/same.ts ');
  await expect(page.locator('mark[data-file-path]')).toHaveCount(1);
  await input.fill('[approval] hold this turn');
  await page.locator('.composer-submit button').click();
  await expect(page.locator('.action-card')).toBeVisible();
  await choose(page, '@same', 'a/same.ts');
  const outgoing = page.waitForRequest(
    (request) => /\/steer$/.test(request.url()) && request.method() === 'POST',
  );
  await page.locator('.composer-submit button').click();
  const sent = await outgoing;
  const id = new URL(sent.url()).pathname.split('/')[3]!;
  await expect(input).toHaveValue('');
  const thread = await (await request.get(`/api/threads/${id}`)).json();
  expect(thread.turns).toHaveLength(1);
  expect(
    thread.turns[0].items.filter((item: { type: string }) => item.type === 'userMessage').at(-1)
      .text,
  ).toBe('a/same.ts ');
});

test('submits native file paths, exact skill identity and images through the existing first-message chain', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const input = editor(page);
  await input.fill('Read ');
  await choose(page, '@"docs/中文 ', 'docs/中文 说明.md');
  await choose(page, '@same', 'a/same.ts');
  await input.pressSequentially('$review-code');
  await expect(page.locator('.skill-reference-menu').getByRole('option')).toHaveCount(2);
  await input.press('Enter');
  await page.locator('input[type=file]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/files-bound-images.png', animations: 'disabled' });
  const outgoing = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/threads\/[^/]+\/turns$/.test(r.url()),
  );
  await page.locator('.composer-submit button').click();
  const sent = await outgoing;
  const body = sent.postDataJSON();
  expect(body.files.map((f: { path: string }) => f.path)).toEqual([
    'docs/中文 说明.md',
    'a/same.ts',
  ]);
  expect(body.skills).toHaveLength(1);
  expect(body.images).toHaveLength(1);
  await expect(input).toHaveValue('');
  const id = new URL(sent.url()).pathname.split('/')[3]!;
  await expect
    .poll(async () => {
      const thread = await (await request.get(`/api/threads/${id}`)).json();
      return thread.turns
        .at(-1)
        ?.items.find((item: { type: string }) => item.type === 'userMessage')?.text;
    })
    .toBe('Read "docs/中文 说明.md" a/same.ts $review-code \n[skill]');
});

test('late query and workspace responses cannot cross into new drafts, and bound drafts recover on navigation/reload', async ({
  page,
}) => {
  await open(page);
  await editor(page).fill('Keep original session [title-fail]');
  await editor(page).press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const originalId = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const pending: Route[] = [];
  await page.route('**/api/files/search', async (route) => {
    if (route.request().postDataJSON().query === 'old') pending.push(route);
    else await route.continue();
  });
  await editor(page).fill('@old');
  await expect.poll(() => pending.length).toBe(1);
  await editor(page).fill('@same');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await pending[0]!
    .fulfill({ json: { cwd: '/old', paths: ['old-private.txt'], limited: false } })
    .catch(() => {});
  await expect(menu(page)).not.toContainText('old-private.txt');
  await editor(page).press('Tab');
  await editor(page).pressSequentially('@old');
  await expect.poll(() => pending.length).toBe(2);
  const original = await editor(page).inputValue();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await editor(page).fill('@other');
  await expect(menu(page).getByRole('option')).toContainText('other-only.txt');
  await pending[1]!
    .fulfill({ json: { cwd: '/old', paths: ['old-private.txt'], limited: false } })
    .catch(() => {});
  await expect(menu(page)).not.toContainText('old-private.txt');
  await page.locator(`[data-thread-id="${originalId}"]`).click();
  await expect(editor(page)).toHaveValue(original);
  await expect(page.locator('mark[data-file-path]')).toHaveCount(1);
  await page.evaluate(async () => {
    const tasks: Promise<void>[] = [];
    window.dispatchEvent(new CustomEvent('covro:prepare-upgrade-reload', { detail: tasks }));
    await Promise.all(tasks);
  });
  await page.reload();
  await expect(editor(page)).toHaveValue(original);
  await expect(page.locator('mark[data-file-path]')).toHaveCount(1);
});

test('empty/error/offline search and failed sends retain the exact bound draft; slash and literal @ stay independent', async ({
  page,
  context,
}) => {
  await open(page);
  const input = editor(page);
  await input.fill('literal a@b.com \\@docs');
  await expect(menu(page)).toHaveCount(0);
  await input.fill('@not-present');
  await expect(menu(page)).toContainText('没有匹配的文件');
  await input.fill('@same');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await input.press('Tab');
  const saved = await input.inputValue();
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'FILE_REFERENCE_NOT_FOUND', message: 'File was moved or deleted' } },
    }),
  );
  await page.locator('.composer-submit button').click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文件已移动或删除' }).first(),
  ).toBeVisible();
  await expect(input).toHaveValue(saved);
  await expect(page.locator('mark[data-file-path]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/files-deleted-draft.png', animations: 'disabled' });
  await input.press('Home');
  await page.keyboard.insertText('/status ');
  await page.locator('.composer-submit button').click();
  await expect(page.locator('.slash-feedback')).toContainText('请先移除文件引用');
  await input.fill('@same');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await context.setOffline(true);
  await expect(menu(page)).toContainText('当前离线');
  await expect(menu(page).getByRole('option')).toHaveCount(0);
  await expect(input).toHaveValue('@same');
  await context.setOffline(false);
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await page.route('**/api/files/search', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'FILE_REFERENCE_UNREADABLE', message: 'read failed' } },
    }),
  );
  await menu(page).getByRole('button', { name: '重新加载' }).click();
  await expect(menu(page)).toContainText('所选文件不可读取');
  await expect(input).toHaveValue('@same');
});

test('IME confirmation never selects or sends; mobile Enter inserts newline and touch selection sends files', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: testOrigin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await confirmCompatibility(page);
    const input = editor(page);
    await input.fill('@same');
    await input.dispatchEvent('compositionstart');
    await input.press('Enter');
    await expect(page.locator('mark[data-file-path]')).toHaveCount(0);
    await input.dispatchEvent('compositionend', { data: '文' });
    await input.fill('@same');
    await expect(menu(page).getByRole('option')).toHaveCount(2);
    await menu(page).getByRole('option').first().tap();
    await input.press('Enter');
    await expect(input).toHaveValue('@a/same.ts \n');
    const sent = page.waitForRequest((r) => /\/turns$/.test(r.url()) && r.method() === 'POST');
    await page.locator('.composer-submit button').tap();
    expect((await sent).postDataJSON().files[0].path).toBe('a/same.ts');
    await expect(input).toHaveValue('');
  } finally {
    await context.close();
  }
});

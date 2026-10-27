import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ServerMessage, ThreadSummaryPage, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  projectGroup,
  testOrigin,
  expectThreadReady,
} from './helpers';

const selectedId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
const row = (page: Page, id: string) =>
  page.locator('.thread-row').filter({ has: page.locator(`[data-thread-id="${id}"]`) });
async function archive(page: Page, id: string, restore = false) {
  await row(page, id)
    .getByRole('button', { name: restore ? '取消归档' : '归档会话', exact: true })
    .click();
}
async function create(page: Page, text: string) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const id = (await selectedId(page))!;
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  return id;
}
async function expectEmpty(page: Page) {
  await expect(page.getByRole('heading', { name: '开始你的下一项任务' })).toBeVisible();
  await expect(page.locator('.thread-link[aria-current="page"]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '会话', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  // React commits the empty view before its storage effect; other tabs also converge asynchronously.
  await expect.poll(() => selectedId(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('codex-web.project'))).toBe('fixture');
}
async function openArchived(page: Page, id: string) {
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await row(page, id).locator('.thread-link').click();
  await expect(page.locator('.archive-notice')).toBeVisible();
}
async function seedThread(request: APIRequestContext, project = 'fixture') {
  const response = await request.post(`/api/projects/${project}/threads`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const id = ((await response.json()).result as { threadId: string }).threadId;
  const started = await request.post(`/api/threads/${id}/turns`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), text: '已有会话历史 [title-fail]' },
  });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/threads/${id}`);
      return ((await detail.json()) as ThreadView).turns.at(-1)?.status;
    })
    .toBe('completed');
  return id;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('leaves the archived conversation without creating a new one, then explicitly restores its history', async ({
  page,
  request,
}) => {
  const id = await create(page, '请保存这段会话历史，稍后继续。');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(row(page, id)).toContainText('Codex 配置继承与运行设置');
  await page.getByRole('textbox', { name: '任务内容' }).fill('取消归档后保留的草稿');
  const action = row(page, id).getByRole('button', { name: '归档会话', exact: true });
  const hint = page.getByRole('tooltip').filter({ hasText: /^归档会话$/ });
  await expect(hint).toHaveCount(0);
  await expect(hint).toBeHidden();
  await action.hover();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('归档会话');
  const actionBox = (await action.boundingBox())!;
  const hintBox = (await page.locator('[data-slot="tooltip-content"]').boundingBox())!;
  expect(hintBox.y).toBeGreaterThanOrEqual(actionBox.y + actionBox.height);
  expect(hintBox.y).toBeLessThanOrEqual(actionBox.y + actionBox.height + 16);
  expect(Math.abs(hintBox.x + hintBox.width - actionBox.x - actionBox.width)).toBeLessThan(1);
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(hint).toBeHidden();
  await action.hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hint).toBeHidden();
  await action.focus();
  await action.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('归档会话');
  await page.screenshot({
    path: test.info().outputPath('archive-icon.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const listReads: string[] = [];
  let creates = 0;
  page.on('request', (request) => {
    if (/\/api\/projects\/[^/]+\/threads(?:\?|$)/.test(request.url())) {
      if (request.method() === 'GET') listReads.push(request.url());
      else if (request.method() === 'POST') creates++;
    }
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expectEmpty(page);
  await expect(row(page, id)).toHaveCount(0);
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  const active = (await (await request.get('/api/projects/fixture/threads')).json()).data as {
    id: string;
  }[];
  expect(active.map((thread) => thread.id)).not.toContain(id);
  expect(listReads).toEqual([]);
  expect(creates).toBe(0);
  await page.screenshot({
    path: test.info().outputPath('archived.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await openArchived(page, id);
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('取消归档后保留的草稿');
  await archive(page, id);
  await expectEmpty(page);
  await page.reload();
  await expectEmpty(page);
  await projectGroup(page, '另一个项目').locator('.project-link').click();
  await projectGroup(page).locator('.project-link').click();
  await expectEmpty(page);
  await openArchived(page, id);
  await page.reload();
  await expect(page.locator('.archive-notice')).toBeVisible();
  expect(await selectedId(page)).toBe(id);
  await expect(page.locator('.conversation-content')).toContainText(
    '请保存这段会话历史，稍后继续。',
  );
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(row(page, id)).toHaveCount(0);
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await row(page, id).locator('.thread-link').click();
  const restored = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/threads/${id}/archive`) &&
      response.request().postDataJSON()?.archived === false &&
      response.ok(),
  );
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await restored;
  await expect(page.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('继续原来的对话');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const thread = await (await request.get(`/api/threads/${id}`)).json();
  expect(thread.archived).toBe(false);
  expect(thread.turns).toHaveLength(2);
  expect(await selectedId(page)).toBe(id);
  await page.screenshot({
    path: test.info().outputPath('restored.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('disables archive for running approvals and synchronizes completed archive changes across tabs', async ({
  page,
  context,
}) => {
  // Reproduce a client that unsubscribed before receiving its archive detail.
  // The overview still delivers both lifecycle changes while that detail is absent.
  let replayArchiveDetails = false;
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (
        message.type === 'event' &&
        message.kind === 'threadPatch' &&
        !replayArchiveDetails &&
        (message.payload as import('../../src/shared/thread-patch').ThreadPatch).thread.archived
      )
        return;
      socket.send(raw);
    });
  });
  const id = await create(page, '[approval] 等待批准后才能归档');
  await expect(page.locator('.action-card')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.action-card')).toBeVisible();
  const action = row(page, id).getByRole('button', { name: '归档会话', exact: true });
  await expect(action).toBeDisabled();
  await action.focus();
  await action.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('tooltip').filter({ hasText: '任务结束并处理完待办后可归档' }),
  ).toHaveText('任务结束并处理完待办后可归档');
  await page.screenshot({
    path: test.info().outputPath('archive-active.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('tooltip').filter({ hasText: '任务结束并处理完待办后可归档' }),
  ).toBeHidden();
  await page.locator('.action-card').getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(other.locator('.turn-heading .status')).toHaveText('已完成');
  await archive(page, id);
  for (const tab of [page, other]) await expectEmpty(tab);
  await openArchived(other, id);
  await other.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.locator('.archive-notice')).toHaveCount(0);
  replayArchiveDetails = true;
  await row(page, id).locator('.thread-link').click();
  await page.getByRole('textbox', { name: '任务内容' }).fill('恢复后继续');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('failed archive and restore writes keep the saved state and show an actionable error', async ({
  page,
}) => {
  const id = await create(page, '归档失败时保留历史');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const path = `**/api/threads/${id}/archive`;
  const reject = () =>
    page.route(path, (route) =>
      route.fulfill({
        status: 400,
        json: { error: { code: 'CODEX_REQUEST_FAILED', message: 'Codex 无法归档此会话，请重试' } },
      }),
    );
  await reject();
  await archive(page, id);
  await expect(page.locator('.error-banner.dismissible')).toContainText('Codex 无法归档此会话');
  await expect(row(page, id)).toBeVisible();
  await expect(row(page, id).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.archive-notice')).toHaveCount(0);
  await page.unroute(path);
  // The row disappears optimistically. Wait for the actual write before querying archives.
  const committed = page.waitForResponse(
    (response) => response.url().endsWith(`/api/threads/${id}/archive`) && response.ok(),
  );
  await archive(page, id);
  await committed;
  await expectEmpty(page);
  await openArchived(page, id);
  await reject();
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('Codex 无法归档此会话');
  await expect(page.locator('.archive-notice')).toBeVisible();
  await expect(row(page, id)).toBeVisible();
});

test('recovers a committed archive after losing its HTTP receipt, without resending', async ({
  page,
}) => {
  const id = await create(page, '丢失回执时核对保存状态');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  let writes = 0;
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    writes++;
    await route.fetch();
    await route.abort('failed');
  });
  await archive(page, id);
  await expectEmpty(page);
  await page.reload();
  await expectEmpty(page);
  expect(writes).toBe(1);
});

test('archiving another conversation preserves the current draft, loaded pages and sidebar position', async ({
  page,
  request,
}) => {
  const current = await create(page, '继续阅读的会话');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const ids = await Promise.all(Array.from({ length: 18 }, () => seedThread(request)));
  const target = ids[8]!;
  // The fixture has a single upstream page. Split real records to exercise browser pagination.
  const snapshot = (await (
    await request.get('/api/projects/fixture/threads')
  ).json()) as ThreadSummaryPage;
  await page.route('**/api/projects/fixture/threads?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('cursor') !== 'archive-test-page-2')
      return route.continue();
    await route.fulfill({ json: { ...snapshot, data: snapshot.data.slice(10), nextCursor: null } });
  });
  await page.route('**/api/projects/fixture/threads', (route) =>
    route.fulfill({
      json: { ...snapshot, data: snapshot.data.slice(0, 10), nextCursor: 'archive-test-page-2' },
    }),
  );
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  // A first-page refresh must preserve the rows already delivered through realtime.
  await expect(
    page.locator([current, ...ids].map((id) => `[data-thread-id="${id}"]`).join(',')),
  ).toHaveCount(19);
  await projectGroup(page).getByRole('button', { name: '加载更多会话' }).click();
  await expect(projectGroup(page).getByText('已加载全部会话', { exact: true })).toBeAttached();
  await expect(
    page.locator([current, ...ids].map((id) => `[data-thread-id="${id}"]`).join(',')),
  ).toHaveCount(19);
  // Visit the target first so reopening archived history also exercises an older detail cache.
  await row(page, target).locator('.thread-link').click();
  await expect(page.locator('.user-text')).toHaveText('已有会话历史 [title-fail]');
  await row(page, current).locator('.thread-link').click();
  await expect(page.locator('.conversation-content')).toContainText('继续阅读的会话');
  await page.getByRole('textbox', { name: '任务内容' }).fill('当前会话的未发送草稿');
  await row(page, target).scrollIntoViewIfNeeded();
  const navigation = page.getByRole('navigation', { name: '会话历史' });
  const before = await navigation.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/projects\/[^/]+\/threads/.test(request.url()))
      reads.push(request.url());
  });
  await archive(page, target);
  await expect(row(page, target)).toHaveCount(0);
  await expect(
    page.locator([current, ...ids].map((id) => `[data-thread-id="${id}"]`).join(',')),
  ).toHaveCount(18);
  await expect(row(page, current).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('当前会话的未发送草稿');
  expect(await selectedId(page)).toBe(current);
  expect(reads).toEqual([]);
  expect(
    Math.abs((await navigation.evaluate((element) => element.scrollTop)) - before),
  ).toBeLessThan(60);
  await page.screenshot({
    path: test.info().outputPath('archive-other.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.unroute('**/api/projects/fixture/threads');
  await page.unroute('**/api/projects/fixture/threads?*');
  await openArchived(page, target);
  await expect(row(page, target).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
});

for (const destination of ['thread', 'project'] as const) {
  test(`late archive events and receipts preserve a newly selected ${destination}`, async ({
    page,
    request,
  }) => {
    const target = await create(page, '归档中切换到其他工作');
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    const project = destination === 'project' ? 'fixture-other' : 'fixture';
    const other = await seedThread(request, project);
    const dispatch = deferred();
    const receipt = deferred();
    const committed = deferred();
    await page.route(`**/api/threads/${target}/archive`, async (route) => {
      await dispatch.promise;
      const response = await route.fetch();
      committed.resolve();
      await receipt.promise;
      await route.fulfill({ response });
    });
    await archive(page, target);
    await expect(row(page, target)).toHaveCount(0);
    await expect(page.locator('.mutation-notice')).toContainText('正在归档会话');
    await row(page, other).locator('.thread-link').click();
    await expect(page.locator('.user-text')).toHaveText('已有会话历史 [title-fail]');
    await page.getByRole('textbox', { name: '任务内容' }).fill('新选择的会话草稿');
    const reads: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        /\/api\/(?:projects\/[^/]+\/threads|threads\/)/.test(request.url())
      )
        reads.push(request.url());
    });
    dispatch.resolve();
    await committed.promise;
    await expect(row(page, target)).toHaveCount(0);
    await expect(row(page, other).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
    const response = page.waitForResponse(`**/api/threads/${target}/archive`);
    receipt.resolve();
    await response;
    await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('新选择的会话草稿');
    await expect(row(page, other).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
    expect(reads).toEqual([]);
    if (destination === 'project') {
      // The late summary must also forget the archived selection in its original project.
      await projectGroup(page).locator('.project-link').click();
      await expectEmpty(page);
    }
    await page.reload();
    if (destination === 'project') await expectEmpty(page);
    else
      await expect(row(page, other).locator('.thread-link')).toHaveAttribute(
        'aria-current',
        'page',
      );
  });
}

test('archiving the current conversation on a narrow screen keeps navigation ready for other work', async ({
  page,
}) => {
  const id = await create(page, '窄屏归档后继续下一项工作');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await archive(page, id);
  await expect(row(page, id)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await projectGroup(page).locator('.project-link').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('archive-mobile-navigation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  await expectEmpty(page);
  await page.screenshot({
    path: test.info().outputPath('archive-mobile-empty.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expectEmpty(page);
});

test('archived unmanaged history is viewable on mobile without automatically resuming it', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'free' });
  await page.goto('/');
  await confirmCompatibility(page);
  const result = await request.post(`/api/threads/${id}/archive`, {
    headers: { Origin: testOrigin },
    data: { archived: true, clientOperationId: randomUUID() },
  });
  expect(result.ok()).toBe(true);
  let resumes = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/resume')) resumes++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await row(page, id!).locator('.thread-link').click();
  await expect(page.locator('.archive-notice')).toBeVisible();
  await expect(page.locator('.conversation-content')).toContainText('已保存的会话历史');
  await expect(page.getByText('正在恢复会话…', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('archived-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(resumes).toBe(0);
});

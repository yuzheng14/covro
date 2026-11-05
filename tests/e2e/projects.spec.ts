import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, ServerMessage, ThreadPage, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  projectGroup,
  saveConversationHistory,
  testOrigin,
  expectThreadReady,
  createEmptyThread,
} from './helpers';

const headers = { Origin: testOrigin };
const first = 'fixture';
const second = 'fixture-other';
const row = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const currentProject = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.project'));
const selected = (page: Page, projectId: string) =>
  page.evaluate((id) => localStorage.getItem(`codex-web.selected:${id}`), projectId);

async function chooseSetting(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}

async function submit(request: APIRequestContext, path: string, body: object = {}) {
  const response = await request.post(path, {
    headers,
    data: { clientOperationId: randomUUID(), ...body },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}
async function readThread(request: APIRequestContext, id: string): Promise<ThreadView> {
  const response = await request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}
async function create(request: APIRequestContext, projectId: string, withHistory = false) {
  const id = (
    (await submit(request, `/api/projects/${projectId}/threads`)).result as { threadId: string }
  ).threadId;
  if (withHistory) {
    await submit(request, `/api/threads/${id}/turns`, { text: '已有项目历史 [title-fail]' });
    await expect
      .poll(async () => (await readThread(request, id)).turns.at(-1)?.status)
      .toBe('completed');
  }
  return id;
}
async function createInPage(page: Page, projectId: string, name: string) {
  await projectGroup(page, name).getByRole('button', { name, exact: true }).click();
  await createEmptyThread(page, name);
  await expectThreadReady(page);
  await expect.poll(() => currentProject(page)).toBe(projectId);
  await expect.poll(() => selected(page, projectId)).toBeTruthy();
  return (await selected(page, projectId))!;
}
async function startApproval(request: APIRequestContext, id: string, text: string) {
  await submit(request, `/api/threads/${id}/turns`, { text: `[approval] ${text}` });
  await expect.poll(async () => (await readThread(request, id)).actions.length).toBe(1);
}
async function approve(request: APIRequestContext, id: string) {
  const thread = await readThread(request, id);
  const action = thread.actions.find((entry) => entry.status === 'pending')!;
  await submit(request, `/api/actions/${action.actionId}/resolve`, {
    resolution: { decision: action.options[0]!.id },
  });
  await expect
    .poll(async () => (await readThread(request, id)).turns.at(-1)?.status)
    .toBe('completed');
}
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(projectGroup(page)).toBeVisible();
  await expect(projectGroup(page, '另一个项目')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test.afterEach(async ({ request }) => {
  for (const projectId of [first, second]) {
    const response = await request.get(`/api/threads?projectId=${projectId}`);
    if (!response.ok()) continue;
    const threads = (await response.json()) as ThreadPage;
    for (const thread of threads.data) {
      const turn = thread.turns.findLast((entry) =>
        ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
      );
      if (!turn) continue;
      await submit(request, `/api/threads/${thread.id}/interrupt`, { expectedTurnId: turn.id });
      await expect
        .poll(async () => (await readThread(request, thread.id)).turns.at(-1)?.status)
        .toBe('interrupted');
    }
  }
});

test('all projects remain visible while independent tasks run and drafts stay with their conversations', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await expect(page.locator('select#project')).toHaveCount(0);
  await expect(
    projectGroup(page, '不可用项目').getByRole('button', { name: '新建会话', exact: true }),
  ).toBeDisabled();
  const a = await createInPage(page, first, '测试项目');
  await saveConversationHistory(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('项目 A 的独立草稿');
  const b = await createInPage(page, second, '另一个项目');
  await saveConversationHistory(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('项目 B 的独立草稿');
  await row(page, a).click();
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '项目 A 的独立草稿',
  );
  await row(page, b).click();
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '项目 B 的独立草稿',
  );

  // Both real gateway executions stay active in different directories.
  await startApproval(request, a, '项目 A：检查变更');
  await startApproval(request, b, '项目 B：等待确认');
  await expect(row(page, a)).toContainText('等待审批');
  await expect(row(page, b)).toContainText('等待审批');
  await expect(row(page, a)).toContainText('1 项待处理');
  await expect(row(page, b)).toContainText('1 项待处理');
  await expect(page.locator('.action-card')).toHaveCount(1);
  await approve(request, a);
  await expect(row(page, a)).toContainText('已完成');
  await expect(row(page, a)).not.toContainText('待处理');
  await expect(row(page, b)).toContainText('等待审批');
  await expect.poll(() => currentProject(page)).toBe(second);
  await expect(page.getByRole('textbox', { name: '追加要求', exact: true })).toHaveValue(
    '项目 B 的独立草稿',
  );
  await page.locator('.project-list').evaluate((element) => {
    element.scrollTop = 0;
  });
  const desktopScreenshot = testInfo.outputPath('project-overview-desktop.png');
  await page.screenshot({
    path: desktopScreenshot,
    fullPage: true,
    animations: 'disabled',
  });
  await testInfo.attach('project-overview-desktop', {
    path: desktopScreenshot,
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await expect(projectGroup(page)).toBeVisible();
  await expect(projectGroup(page, '另一个项目')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.project-list').evaluate((element) => {
    element.scrollTop = 0;
  });
  const mobileScreenshot = testInfo.outputPath('project-overview-mobile.png');
  await page.screenshot({
    path: mobileScreenshot,
    fullPage: true,
    animations: 'disabled',
  });
  await testInfo.attach('project-overview-mobile', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });
  await row(page, a).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '项目 A 的独立草稿',
  );
});

test('a slow project list cannot roll back a live completion and reconnect refreshes background projects', async ({
  page,
  request,
  context,
}) => {
  await open(page);
  await createInPage(page, first, '测试项目');
  const b = await create(request, second);
  await startApproval(request, b, '后台项目状态');
  await expect(row(page, b)).toContainText('等待审批');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const capture = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route('**/api/projects/fixture-other/threads', async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await capture;
  await approve(request, b);
  await expect(row(page, b)).toContainText('已完成');
  release();
  await expect(projectGroup(page, '另一个项目').getByText('正在读取会话…')).toHaveCount(0);
  await expect(row(page, b)).toContainText('已完成');
  await page.unroute('**/api/projects/fixture-other/threads');

  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  const newBackground = await create(request, second);
  await startApproval(request, newBackground, '断线期间新建的会话');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(row(page, newBackground)).toContainText('等待审批');
  await expect.poll(() => currentProject(page)).toBe(first);
});

test('project loading errors are isolated and navigation stays usable with unavailable directories', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/projects/fixture-other/threads', async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '此项目暂时读取失败' } },
      });
    else await route.continue();
  });
  await open(page);
  await expect(
    projectGroup(page, '另一个项目').getByRole('button', { name: '加载失败，重试' }),
  ).toHaveAccessibleDescription(/服务暂时不可用/);
  await expect(projectGroup(page, '不可用项目').locator('.project-error')).toBeVisible();
  await createInPage(page, first, '测试项目');
  fail = false;
  await projectGroup(page, '另一个项目').getByRole('button', { name: '加载失败，重试' }).click();
  await expect(projectGroup(page, '另一个项目')).not.toContainText('此项目暂时读取失败');
  await page.getByRole('searchbox', { name: '搜索项目与已加载会话' }).fill('另一个项目');
  await expect(projectGroup(page)).toHaveCount(0);
  await expect(projectGroup(page, '另一个项目')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索项目与已加载会话' }).fill('');
  await expect(projectGroup(page)).toBeVisible();
});

test('project overview drafts and execution settings remain independent before a conversation is selected', async ({
  page,
}) => {
  await open(page);
  const input = page.getByRole('textbox', { name: '任务内容', exact: true });
  await input.fill('项目 A 概览草稿');
  await chooseSetting(page, '权限模式', '请求批准');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    '',
  );
  await input.fill('项目 B 概览草稿');
  await chooseSetting(page, '权限模式', '请求批准');
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect(input).toHaveValue('项目 A 概览草稿');
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    'ask',
  );
  const creation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/api/projects/fixture-other/threads'),
  );
  // This assertion concerns the browser's real first-message creation, not fixture setup.
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await expect(input).toHaveValue('项目 B 概览草稿');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await creation).postDataJSON().settings).toEqual({ permissionMode: 'ask' });
  await expect(input).toHaveValue('');
});

test('each project retains its loaded pages when navigating to another project', async ({
  page,
  request,
}) => {
  await open(page);
  const a1 = await create(request, first, true);
  const a2 = await create(request, first, true);
  let reads = 0;
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++;
    const response = await route.fetch();
    const data = await response.json();
    const more = new URL(route.request().url()).searchParams.has('cursor');
    await route.fulfill({
      response,
      json: {
        ...data,
        data: data.data.filter((thread: { id: string }) => thread.id === (more ? a2 : a1)),
        nextCursor: more ? null : 'second-page',
      },
    });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(row(page, a1)).toBeVisible();
  // Refreshing one page keeps previously observed rows until the traversal finishes.
  await expect(row(page, a2)).toBeVisible();
  await projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }).click();
  await expect(projectGroup(page).getByText('已加载全部会话', { exact: true })).toBeVisible();
  await expect(row(page, a2)).toBeVisible();
  await row(page, a2).click();
  await expect(page.locator('.turn')).toHaveCount(1);
  const before = reads;
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect.poll(() => currentProject(page)).toBe(second);
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect.poll(() => currentProject(page)).toBe(first);
  await expect(row(page, a1)).toBeVisible();
  await expect(row(page, a2)).toBeVisible();
  await expect(
    projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(before);
});

test('a late create receipt updates its project without stealing navigation back from another project', async ({
  page,
  request,
}) => {
  let delaying = false;
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (
        delaying &&
        message.type === 'event' &&
        message.kind === 'operation' &&
        (message.payload as Operation).kind === 'thread.create'
      )
        return;
      socket.send(raw);
    });
  });
  await open(page);
  const a = await createInPage(page, first, '测试项目');
  await saveConversationHistory(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('当前会话的草稿');
  delaying = true;
  await page.route('**/api/operations/*', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '等待回执' } } }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let capture!: (id: string) => void;
  const created = new Promise<string>((resolve) => {
    capture = resolve;
  });
  await page.route('**/api/projects/fixture-other/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const operation = (await response.json()) as Operation;
    capture((operation.result as { threadId: string }).threadId);
    await gate;
    await route.fulfill({ response });
  });
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await page.locator('.composer-box textarea').fill('首条消息等待创建回执 [title-fail]');
  await page.locator('.composer-box textarea').press('Enter');
  const b = await created;
  await row(page, a).click();
  await expect.poll(() => currentProject(page)).toBe(first);
  release();
  await expect(
    projectGroup(page, '另一个项目').getByRole('button', { name: '新建会话', exact: true }),
  ).toBeEnabled();
  await expect(row(page, b)).toBeVisible();
  await expect.poll(() => currentProject(page)).toBe(first);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '当前会话的草稿',
  );
  expect((await readThread(request, b)).projectId).toBe(second);
});

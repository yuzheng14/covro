import { openModelSettings } from './helpers';
import { expect, test, type Page, type Request } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton, projectGroup } from './helpers';

const input = (page: Page) => page.locator('.composer-box textarea');
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const creation = (request: Request) =>
  request.method() === 'POST' && /\/api\/projects\/[^/]+\/threads$/.test(request.url());
const submission = (request: Request) =>
  request.method() === 'POST' && /\/api\/threads\/[^/]+\/turns$/.test(request.url());
const selected = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}
async function complete(page: Page) {
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(input(page)).toHaveValue('');
}
function outgoing(page: Page) {
  const creates: Request[] = [],
    sends: Request[] = [];
  page.on('request', (request) => {
    if (creation(request)) creates.push(request);
    if (submission(request)) sends.push(request);
  });
  return { creates, sends };
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('welcome sends the first prompt with the chosen settings; project and new entry return to the same draft', async ({
  page,
}) => {
  await open(page);
  const requests = outgoing(page);
  await openModelSettings(page);
  await page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await expect(page.locator('.settings-defaults')).toContainText('已保存');
  await input(page).fill('实现首条消息直接创建会话 [title-fail]');
  await page.screenshot({ path: '/tmp/issue-115-welcome.png', fullPage: true });
  await send(page).click();
  await complete(page);
  expect(requests.creates).toHaveLength(1);
  expect(requests.sends).toHaveLength(1);
  expect(requests.creates[0]!.postDataJSON().settings).toEqual(
    requests.sends[0]!.postDataJSON().settings,
  );
  expect(requests.sends[0]!.postDataJSON()).toMatchObject({
    text: '实现首条消息直接创建会话 [title-fail]',
  });
  const id = await selected(page);
  const thread = await (await page.request.get(`/api/threads/${id}`)).json();
  expect(thread.runtimeSettings.reasoningEffort).toBe('high');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  await page.screenshot({ path: '/tmp/issue-115-success.png', fullPage: true });
  await input(page).fill('会话内的独立草稿');
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect(page.getByTestId('workspace-start')).toBeVisible();
  await expect(input(page)).toHaveValue('');
  expect(await selected(page)).toBeNull();
  await input(page).fill('新会话的草稿');
  await createThreadButton(page).click();
  await expect(input(page)).toHaveValue('新会话的草稿');
  expect(requests.creates).toHaveLength(1);
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(input(page)).toHaveValue('会话内的独立草稿');
  await createThreadButton(page).click();
  await expect(input(page)).toHaveValue('新会话的草稿');
  await send(page).click();
  await complete(page);
  expect(requests.creates).toHaveLength(2);
  expect(requests.sends).toHaveLength(2);
});

test('creation failure retains text and pasted images and permits one explicit retry', async ({
  page,
}) => {
  await open(page);
  const requests = outgoing(page);
  await page.route('**/api/projects/fixture/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 400,
      json: { error: { code: 'CREATE_FAILED', message: '创建失败，请重试' } },
    });
  });
  await input(page).fill('创建失败后保留草稿');
  await input(page).evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [
          Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            ),
            (c) => c.charCodeAt(0),
          ),
        ],
        'test.png',
        { type: 'image/png' },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  await send(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('创建失败，请重试');
  await expect(input(page)).toHaveValue('创建失败后保留草稿');
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  await expect(send(page)).toBeEnabled();
  expect(requests.sends).toHaveLength(0);
  await page.unroute('**/api/projects/fixture/threads');
  await send(page).click();
  await complete(page);
  await expect(page.locator('.message-images img')).toHaveCount(1);
  expect(requests.creates).toHaveLength(2);
  expect(requests.sends).toHaveLength(1);
});

test('a failed first send keeps its draft and settings on the created thread and retries without recreating', async ({
  page,
}) => {
  await open(page);
  const requests = outgoing(page);
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'SEND_FAILED', message: '首轮发送失败，请重试' } },
    }),
  );
  await input(page).fill('复用已经创建的会话');
  await send(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('首轮发送失败，请重试');
  await expect(input(page)).toHaveValue('复用已经创建的会话');
  await expect(send(page)).toBeEnabled();
  const id = await selected(page);
  expect(id).toBeTruthy();
  await page.screenshot({ path: '/tmp/issue-115-send-failed.png', fullPage: true });
  await page.unroute('**/api/threads/*/turns');
  await send(page).click();
  await complete(page);
  expect(await selected(page)).toBe(id);
  expect(requests.creates).toHaveLength(1);
  expect(requests.sends).toHaveLength(2);
  expect(requests.sends[0]!.url()).toBe(requests.sends[1]!.url());
});

test('duplicate Enter and click events cannot duplicate creation or the first prompt during either stage', async ({
  page,
}) => {
  await open(page);
  const requests = outgoing(page);
  let releaseCreate!: () => void, releaseSend!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route('**/api/projects/fixture/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await createGate;
    await route.continue();
  });
  await page.route('**/api/threads/*/turns', async (route) => {
    await sendGate;
    await route.continue();
  });
  await input(page).fill('只创建一次，只发送一次');
  await input(page).evaluate((element) => {
    for (let i = 0; i < 3; i++)
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
  });
  await expect(page.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled();
  await expect(page.getByText('正在创建会话并发送首条消息…')).toBeVisible();
  await page.screenshot({ path: '/tmp/issue-115-creating.png', fullPage: true });
  expect(requests.creates).toHaveLength(1);
  releaseCreate();
  await expect.poll(() => requests.sends.length).toBe(1);
  await input(page).press('Enter');
  await page
    .getByRole('button', { name: '正在提交…', exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  expect(requests.creates).toHaveLength(1);
  expect(requests.sends).toHaveLength(1);
  await expect(input(page)).toHaveValue('只创建一次，只发送一次');
  releaseSend();
  await complete(page);
  await expect(page.locator('.turn')).toHaveCount(1);
});

test('mobile project navigation closes the drawer and starts a conversation from the shared welcome page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await input(page).fill('在手机上直接开始任务');
  await expect(send(page)).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/issue-115-mobile.png', fullPage: true });
  await send(page).click();
  await complete(page);
});

for (const stage of ['create', 'send'] as const) {
  test(`an uncertain ${stage} receipt preserves the draft and prevents duplicates until reconciled`, async ({
    page,
  }) => {
    await page.routeWebSocket('**/ws?overview=1', (socket) => {
      const server = socket.connectToServer();
      server.onMessage((raw) => {
        const message = JSON.parse(raw.toString());
        if (
          message.type === 'event' &&
          message.kind === 'operation' &&
          message.payload.kind === (stage === 'create' ? 'thread.create' : 'turn.start') &&
          message.payload.status === 'acknowledged'
        )
          return;
        socket.send(raw);
      });
    });
    await open(page);
    const requests = outgoing(page);
    await page.route('**/api/operations/*', (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '回执暂不可用' } },
      }),
    );
    const path = stage === 'create' ? '**/api/projects/fixture/threads' : '**/api/threads/*/turns';
    await page.route(path, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.fulfill({
        status: 409,
        json: { error: { code: 'RESULT_UNKNOWN', message: '提交结果尚未确认' } },
      });
    });
    await input(page).fill('等待回执确认的首条消息');
    await send(page).click();
    await expect(page.locator('.pending-notice')).toBeVisible();
    await expect(send(page)).toBeDisabled();
    await expect(input(page)).toHaveValue('等待回执确认的首条消息');
    await input(page).press('Enter');
    expect(requests.creates).toHaveLength(1);
    expect(requests.sends).toHaveLength(stage === 'create' ? 0 : 1);
    await page.unroute('**/api/operations/*');
    await page.unroute(path);
    await page.getByRole('button', { name: '核对提交', exact: true }).click();
    if (stage === 'create') {
      await expect.poll(() => selected(page)).toBeTruthy();
      await expect(send(page)).toBeEnabled();
      await expect(input(page)).toHaveValue('等待回执确认的首条消息');
      await send(page).click();
    }
    await complete(page);
    expect(requests.creates).toHaveLength(1);
    expect(requests.sends).toHaveLength(1);
    await expect(page.locator('.turn')).toHaveCount(1);
  });
}

test('late creation and first-send receipts do not steal navigation or clear another project draft', async ({
  page,
}) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/fixture/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.continue();
  });
  const requests = outgoing(page);
  await input(page).fill('在原项目继续执行的任务');
  await send(page).click();
  await expect(page.getByText('正在创建会话并发送首条消息…')).toBeVisible();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await input(page).fill('另一个项目的草稿');
  release();
  await expect.poll(() => requests.sends.length).toBe(1);
  const id = new URL(requests.sends[0]!.url()).pathname.split('/')[3]!;
  await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  await expect(input(page)).toHaveValue('另一个项目的草稿');
  await expect(page.locator('.breadcrumb')).toContainText('另一个项目');
  await page.locator(`[data-thread-id="${id}"]`).click();
  await complete(page);
  await expect(page.locator('.user-text')).toHaveText('在原项目继续执行的任务');
});

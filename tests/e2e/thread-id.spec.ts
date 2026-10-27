import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, ServerMessage, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup, testOrigin } from './helpers';

const info = (page: Page) => page.getByRole('region', { name: '当前会话信息' });
const row = (page: Page, id: string) =>
  page.locator('.thread-row').filter({ has: page.locator(`[data-thread-id="${id}"]`) });
const copyButton = (page: Page) =>
  info(page).getByRole('button', { name: '复制 Thread ID', exact: true });

async function send(page: Page, text = '检查 Thread ID [title-fail]') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}

async function seed(request: APIRequestContext) {
  const headers = { Origin: testOrigin };
  const response = await request.post('/api/projects/fixture/threads', {
    headers,
    data: { clientOperationId: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const { threadId } = ((await response.json()) as Operation).result as { threadId: string };
  expect(
    (
      await request.post(`/api/threads/${threadId}/turns`, {
        headers,
        data: { clientOperationId: randomUUID(), text: '已有历史 [title-fail]' },
      })
    ).ok(),
  ).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`/api/threads/${threadId}`);
      return ((await response.json()) as ThreadView).turns.at(-1)?.status;
    })
    .toBe('completed');
  return threadId;
}

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});

test('draft, first message and saved conversation show the real ID with selectable and keyboard copy', async ({
  page,
  request,
}) => {
  await page.locator('.diagnostics > summary').click();
  await expect(info(page)).toContainText('会话尚未创建');
  await expect(copyButton(page)).toHaveCount(0);
  const id = await send(page);
  const response = await request.get(`/api/threads/${id}`);
  expect(((await response.json()) as ThreadView).id).toBe(id);
  await expect(info(page).locator('code')).toHaveText(id);
  await copyButton(page).focus();
  await copyButton(page).press('Enter');
  await expect(info(page).getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  await expect(info(page).getByRole('status')).toBeEmpty();

  await page.reload();
  await page.locator('.diagnostics > summary').click();
  await expect(info(page).locator('code')).toHaveText(id);
  await row(page, id)
    .getByRole('button', { name: /^会话详情：/ })
    .click();
  const details = row(page, id).getByTestId('thread-details');
  await expect(details.getByText('Thread ID', { exact: true })).toBeVisible();
  await expect(details.locator('code')).toHaveText(id);
  await expect(details.locator('code')).toHaveCSS('user-select', 'text');
  expect(
    await details.locator('code').evaluate((element) => {
      const selection = window.getSelection()!;
      selection.selectAllChildren(element);
      return selection.toString();
    }),
  ).toBe(id);
  await details.getByRole('button', { name: '复制 Thread ID', exact: true }).click();
  await expect(details.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  await page.screenshot({ path: '/tmp/covro-thread-id-191-desktop.png', animations: 'disabled' });
});

test('Fork shows the new server ID and returning restores the source ID', async ({
  page,
  request,
}) => {
  const source = await send(page);
  await page.locator('.diagnostics > summary').click();
  await copyButton(page).click();
  await expect(info(page).getByRole('status')).toHaveText('已复制');
  await row(page, source).getByRole('button', { name: 'Fork 会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  const fork = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  expect(fork).not.toBe(source);
  const response = await request.get(`/api/threads/${fork}`);
  expect(((await response.json()) as ThreadView).forkedFromId).toBe(source);
  await expect(info(page).locator('code')).toHaveText(fork);
  await expect(info(page).getByRole('status')).toBeEmpty();
  await copyButton(page).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fork);
  await row(page, fork)
    .getByRole('button', { name: /^会话详情：/ })
    .click();
  await expect(row(page, fork).getByTestId('thread-details').locator('code')).toHaveText(fork);
  await page.getByRole('button', { name: '返回原会话', exact: true }).click();
  await expect(info(page).locator('code')).toHaveText(source);
  await expect(info(page).getByRole('status')).toBeEmpty();
});

test('late details and clipboard completion never replace the current session or draft', async ({
  page,
  request,
}) => {
  const source = await send(page);
  const delayedId = await seed(request);
  const target = await seed(request);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (
        message.type !== 'error' &&
        message.threadId === delayedId &&
        (message.type === 'snapshot' ||
          message.type === 'resync' ||
          (message.type === 'event' && message.kind === 'threadPatch'))
      )
        return;
      socket.send(raw);
    });
  });
  await page.route(`**/api/threads/${delayedId}`, async (route) => {
    await delayed;
    await route.continue();
  });
  // Reload with interception installed and no detail cache for the other sessions.
  await page.reload();
  await page.locator('.diagnostics > summary').click();
  await expect(info(page).locator('code')).toHaveText(source);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => new Promise<void>((resolve) => Reflect.set(window, 'finishCopy', resolve)),
      },
    });
  });
  await copyButton(page).click();
  try {
    await page.locator(`[data-thread-id="${delayedId}"]`).click();
    await expect(info(page)).toContainText('正在加载会话详情…');
    await expect(info(page).locator('code')).toHaveCount(0);
    await expect(copyButton(page)).toHaveCount(0);
    await page.locator(`[data-thread-id="${target}"]`).click();
    await expect(info(page).locator('code')).toHaveText(target);
    await page.evaluate(() => Reflect.get(window, 'finishCopy')());
    await expect(info(page).getByRole('status')).toBeEmpty();
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/threads/${delayedId}`),
    );
    release();
    await lateResponse;
    await expect(info(page).locator('code')).toHaveText(target);
    await projectGroup(page).getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(info(page)).toContainText('会话尚未创建');
    await expect(info(page).locator('code')).toHaveCount(0);
    await expect(copyButton(page)).toHaveCount(0);
  } finally {
    release();
  }
});

test('failed detail loading clears the old ID and disables copying', async ({ page, request }) => {
  const source = await send(page);
  const target = await seed(request);
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type !== 'error' && message.threadId === target) return;
      socket.send(raw);
    });
  });
  await page.route(`**/api/threads/${target}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '测试详情不可用' } },
    }),
  );
  await page.reload();
  await page.locator('.diagnostics > summary').click();
  await expect(info(page).locator('code')).toHaveText(source);
  await page.locator(`[data-thread-id="${target}"]`).click();
  await expect(info(page)).toContainText('会话详情加载失败');
  await expect(info(page).locator('code')).toHaveCount(0);
  await expect(copyButton(page)).toHaveCount(0);
});

for (const failure of ['denied', 'unavailable']) {
  test(`clipboard ${failure} offers manual copy and can retry`, async ({ page }) => {
    const id = await send(page);
    await page.locator('.diagnostics > summary').click();
    await page.evaluate((failure) => {
      const clipboard = navigator.clipboard;
      Reflect.set(window, 'restoreClipboard', () =>
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard }),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          failure === 'unavailable'
            ? undefined
            : {
                writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
              },
      });
    }, failure);
    await copyButton(page).click();
    await expect(info(page).getByRole('status')).toHaveText('复制失败，请手动选择 ID 复制。');
    await expect(info(page).locator('code')).toHaveText(id);
    await page.evaluate(() => Reflect.get(window, 'restoreClipboard')());
    await copyButton(page).press('Space');
    await expect(info(page).getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  });
}

test('full IDs wrap in both information areas at 320px and 390px', async ({ page }) => {
  const id = await send(page);
  await page.locator('.diagnostics > summary').click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(info(page).locator('code')).toHaveText(id);
    await expect(copyButton(page)).toBeInViewport();
    await copyButton(page).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    expect(await info(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/covro-thread-id-191-mobile-${width}.png`,
      animations: 'disabled',
    });

    await page.getByRole('button', { name: '打开项目与会话' }).click();
    await row(page, id)
      .getByRole('button', { name: /^会话详情：/ })
      .click();
    const details = row(page, id).getByTestId('thread-details');
    await expect(details.locator('code')).toHaveText(id);
    await details.getByRole('button', { name: '复制 Thread ID', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/covro-thread-id-191-sidebar-${width}.png`,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '关闭导航', exact: true }).click();
    // Collapse before the next width, preserving the same selected conversation.
    await page.getByRole('button', { name: '打开项目与会话' }).click();
    await row(page, id)
      .getByRole('button', { name: /^会话详情：/ })
      .click();
    await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  }
});

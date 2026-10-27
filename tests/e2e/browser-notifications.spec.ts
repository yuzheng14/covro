import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, testOrigin, openSidebarSettings } from './helpers';

test.use({ launchOptions: { args: ['--disable-blink-features=NotificationConstructor'] } });

declare global {
  interface Window {
    persistentNotificationTest: {
      fail: boolean;
      blocked: boolean;
      permission: NotificationPermission;
      shown: { title: string; options: NotificationOptions }[];
    };
    notificationTest: {
      permission: NotificationPermission;
      requested: number;
      fail: boolean;
      shown: { title: string; options: NotificationOptions; click: () => void }[];
    };
  }
}
const evidence = join(tmpdir(), 'covro-issue-248-evidence');
const deliveryEvidence = join(tmpdir(), 'covro-issue-284-evidence');
const dialog = (page: Page) => page.getByRole('dialog', { name: '浏览器通知' });
async function openNotificationSettings(page: Page) {
  await openSidebarSettings(page);
  await page.getByRole('button', { name: /浏览器通知/ }).click();
}
const toggle = (page: Page) => page.getByRole('switch', { name: '浏览器通知' });
const captured = (page: Page) =>
  page.evaluate(() =>
    window.notificationTest.shown.map(({ title, options }) => ({ title, options })),
  );

async function mockNotifications(page: Page, permission: NotificationPermission = 'default') {
  await page.addInitScript((permission) => {
    // Exercise the desktop fallback here; persistent delivery has separate real-worker coverage.
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    const state: Window['notificationTest'] = {
      permission:
        (sessionStorage.getItem('notification-test-permission') as NotificationPermission | null) ??
        permission,
      requested: 0,
      shown: [],
      fail: false,
    };
    window.notificationTest = state;
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static get permission() {
          return state.permission;
        }
        static async requestPermission() {
          state.requested++;
          state.permission = 'granted';
          sessionStorage.setItem('notification-test-permission', state.permission);
          return state.permission;
        }
        onclick?: () => void;
        onerror?: () => void;
        close() {}
        constructor(title: string, options: NotificationOptions = {}) {
          if (state.fail) throw new Error('Notifications unavailable');
          state.shown.push({ title, options, click: () => this.onclick?.() });
        }
      },
    });
  }, permission);
}

async function submit(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(path, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}
async function create(request: APIRequestContext, project = 'fixture', title = '通知验收会话') {
  const created = await submit(request, `/api/projects/${project}/threads`);
  const { threadId } = created.result as { threadId: string };
  await submit(request, `/api/threads/${threadId}/rename`, { name: title });
  return threadId;
}
async function start(request: APIRequestContext, id: string, text = '检查浏览器通知') {
  const operation = await submit(request, `/api/threads/${id}/turns`, {
    text: `${text} [title-fail]`,
  });
  return (operation.result as { turnId: string }).turnId;
}
async function history(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
}
async function waitStatus(request: APIRequestContext, id: string, status: string) {
  await expect.poll(async () => (await history(request, id)).turns.at(-1)?.status).toBe(status);
}
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}
async function enable(page: Page) {
  await openNotificationSettings(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await mkdir(deliveryEvidence, { recursive: true });
});

async function mockPersistentNotifications(page: Page) {
  await page.addInitScript(() => {
    const state: Window['persistentNotificationTest'] = {
      fail: false,
      blocked: false,
      permission: 'granted',
      shown: [],
    };
    window.persistentNotificationTest = state;
    // Headless macOS can deny OS notifications despite granted browser permission.
    // Keep the native Android-incompatible constructor and real worker lifecycle.
    Object.defineProperty(Notification, 'permission', { get: () => state.permission });
    ServiceWorkerRegistration.prototype.showNotification = async function (title, options = {}) {
      if (state.fail) throw new Error('Notification rejected');
      state.shown.push({ title, options });
    };
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (...args) {
      if (state.blocked) return Promise.reject(new Error('Worker blocked'));
      return register.apply(this, args);
    };
  });
}

const persistent = (page: Page) => page.evaluate(() => window.persistentNotificationTest.shown);

async function workerClick(context: BrowserContext, url: string) {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (url) => {
    const scope = self as unknown as {
      clients: {
        matchAll(options: object): Promise<{ url: string; postMessage(value: unknown): void }[]>;
      };
    };
    const pages = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    pages
      .find((page) => new URL(page.url).pathname === '/')!
      .postMessage({ type: 'covro-notification-click', url });
  }, url);
}

test.describe('persistent notifications on browsers without the Notification constructor', () => {
  test('registers a real worker, submits tests and completes work without using the constructor', async ({
    page,
    context,
    request,
  }) => {
    await mockPersistentNotifications(page);
    await open(page);
    expect(
      await page.evaluate(() => {
        try {
          new Notification('probe');
          return '';
        } catch (error) {
          return String(error);
        }
      }),
    ).toContain('ServiceWorkerRegistration.showNotification()');
    expect(
      await page.evaluate(() =>
        navigator.serviceWorker.getRegistrations().then((entries) => entries.length),
      ),
    ).toBe(0);
    await enable(page);
    await page.setViewportSize({ width: 430, height: 932 });
    await page.getByRole('button', { name: '发送测试通知' }).click();
    await expect(dialog(page)).toContainText('通知已提交给浏览器');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    const worker = await page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistrations())[0]!;
      const response = await fetch('/notification-worker.js');
      return {
        state: registration.active?.state,
        cache: response.headers.get('cache-control'),
        mime: response.headers.get('content-type'),
      };
    });
    expect(worker).toMatchObject({ state: 'activated', cache: 'no-store' });
    expect(worker.mime).toMatch(/javascript/);
    await page.screenshot({
      path: join(deliveryEvidence, 'mobile-test-submitted.png'),
    });
    await page.getByRole('button', { name: '关闭通知设置' }).click();
    const id = await create(request, 'fixture-other', '手机通知兼容性');
    await start(request, id);
    await expect.poll(() => persistent(page)).toHaveLength(2);
    const notification = (await persistent(page))[1]!;
    expect(notification).toMatchObject({
      title: 'Agent 已完成',
      options: { body: '另一个项目 · 手机通知兼容性' },
    });
    await workerClick(context, notification.options.data.url);
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  });

  for (const [prompt, title, selector, cold] of [
    ['[approval]', 'Agent 需要审批', '.action-card', false],
    ['[async-questions-running]', 'Agent 需要回答', '.async-question-card', true],
  ] as const) {
    test(`preserves ${title} navigation with ${cold ? 'a new page' : 'an existing page'}`, async ({
      page,
      context,
      request,
    }) => {
      await mockPersistentNotifications(page);
      await open(page);
      await enable(page);
      await page.getByRole('button', { name: '关闭通知设置' }).click();
      const id = await create(request, 'fixture-other', '手机上的待处理请求');
      await start(request, id, prompt);
      await expect.poll(() => persistent(page)).toHaveLength(1);
      const notification = (await persistent(page))[0]!;
      expect(notification.title).toBe(title);
      const url = notification.options.data.url as string;
      let target = page;
      if (cold) {
        await page.close();
        target = await context.newPage();
        await mockPersistentNotifications(target);
        await target.goto(url);
      } else {
        await workerClick(context, url);
      }
      await expect(target.locator(selector).first()).toBeFocused();
      await expect(target.locator(selector).first()).toBeInViewport();
      expect(new URL(target.url()).hash).toBe('');
    });
  }

  test('keeps initialization failures off and recovers on a later explicit attempt', async ({
    page,
  }) => {
    await mockPersistentNotifications(page);
    await open(page);
    await page.evaluate(() => {
      window.persistentNotificationTest.blocked = true;
    });
    await openNotificationSettings(page);
    await toggle(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('通知服务初始化失败');
    await page.screenshot({ path: join(deliveryEvidence, 'desktop-initialization-failed.png') });
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
    expect(
      await page.evaluate(() => localStorage.getItem('codex-web.notifications-enabled')),
    ).not.toBe('1');
    await page.evaluate(() => {
      window.persistentNotificationTest.blocked = false;
    });
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: '发送测试通知' }).click();
    await expect(dialog(page)).toContainText('通知已提交给浏览器');
  });

  test('reports delivery rejection and still permits disabling after permission is revoked', async ({
    page,
  }) => {
    await mockPersistentNotifications(page);
    await open(page);
    await enable(page);
    await page.evaluate(() => {
      window.persistentNotificationTest.fail = true;
    });
    await page.getByRole('button', { name: '发送测试通知' }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('通知发送失败');
    await expect(dialog(page)).toContainText('发送不可用');
    await page.setViewportSize({ width: 430, height: 932 });
    await page.screenshot({ path: join(deliveryEvidence, 'mobile-delivery-failed.png') });
    await page.evaluate(() => {
      window.persistentNotificationTest.permission = 'denied';
      window.dispatchEvent(new Event('focus'));
    });
    await expect(toggle(page)).toBeEnabled();
    await toggle(page).click();
    expect(await page.evaluate(() => localStorage.getItem('codex-web.notifications-enabled'))).toBe(
      '0',
    );
    await expect(toggle(page)).toBeDisabled();
  });

  test('deduplicates persistent notifications across tabs', async ({ page, context, request }) => {
    await mockPersistentNotifications(page);
    await open(page);
    await enable(page);
    await page.getByRole('button', { name: '关闭通知设置' }).click();
    const other = await context.newPage();
    await mockPersistentNotifications(other);
    await other.goto('/');
    await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
    const id = await create(request);
    await start(request, id, '[approval]');
    await waitStatus(request, id, 'waitingApproval');
    await expect
      .poll(async () => (await persistent(page)).length + (await persistent(other)).length)
      .toBe(1);
  });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('asks only after a click, shows guidance, and opens the notified project and conversation', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await openNotificationSettings(page);
  await expect(dialog(page)).toContainText('尚未授权 · 未开启');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  await page.screenshot({ path: join(evidence, 'notifications-off.png') });
  await toggle(page).click();
  await expect(dialog(page)).toContainText('已授权 · 已开启');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(1);
  await page.getByRole('button', { name: '发送测试通知' }).click();
  await expect.poll(() => captured(page)).toHaveLength(1);
  await page.evaluate(() => {
    window.notificationTest.shown = [];
  });
  await page.getByText('如何让本站保持活跃', { exact: true }).click();
  await page.screenshot({ path: join(evidence, 'notifications-on-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, 'notifications-on-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '关闭通知设置' }).click();

  const id = await create(request, 'fixture-other', '跨项目任务结果');
  await start(request, id);
  await expect
    .poll(() => captured(page))
    .toMatchObject([{ title: 'Agent 已完成', options: { body: '另一个项目 · 跨项目任务结果' } }]);
  await page.evaluate(() => window.notificationTest.shown[0]!.click());
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('codex-web.project')))
    .toBe('fixture-other');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('distinguishes failure and interruption, with no notification from reload, rename or history', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const id = await create(request);
  await start(request, id, '[codex-retry-fail]');
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 执行失败' }]);
  const turnId = await start(request, id, '[approval] 等待中断');
  await waitStatus(request, id, 'waitingApproval');
  await expect.poll(() => captured(page)).toHaveLength(2);
  await submit(request, `/api/threads/${id}/interrupt`, { expectedTurnId: turnId });
  await expect
    .poll(() => captured(page))
    .toMatchObject([
      { title: 'Agent 执行失败' },
      { title: 'Agent 需要审批' },
      { title: 'Agent 已中断' },
    ]);
  await submit(request, `/api/threads/${id}/rename`, { name: '重命名不重复通知' });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('重命名不重复通知');
  expect(await captured(page)).toHaveLength(3);
  await page.reload();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  expect(await captured(page)).toHaveLength(0);
  await openNotificationSettings(page);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
});

test('atomically deduplicates simultaneous tabs and shares the notification preference', async ({
  page,
  context,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const other = await context.newPage();
  await mockNotifications(other, 'granted');
  await other.goto('/');
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  await expect
    .poll(async () => (await captured(page)).length + (await captured(other)).length)
    .toBe(1);
  await openNotificationSettings(other);
  await expect(toggle(other)).toHaveAttribute('aria-checked', 'true');
  await toggle(other).click();
  await openNotificationSettings(page);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await start(request, id);
  await waitStatus(request, id, 'completed');
  expect((await captured(page)).length + (await captured(other)).length).toBe(1);
});

test('recovers results and unread markers after freeze/resume lifecycle events without replaying notifications', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const id = await create(request);
  await start(request, id, '[approval] 页面休眠验收');
  await waitStatus(request, id, 'waitingApproval');
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 需要审批' }]);
  await page.evaluate(() => {
    window.notificationTest.shown = [];
  });
  // Headless Chromium keeps pages visible and does not enter the frozen lifecycle state.
  // Dispatch its lifecycle events explicitly; socket closure, server work and recovery are real.
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(page.locator('.connection-badge')).not.toHaveText('实时连接正常');
  const action = (await history(request, id)).actions.find(
    (action) => action.status === 'pending',
  )!;
  await submit(request, `/api/actions/${action.actionId}/resolve`, {
    resolution: { decision: action.options[0]!.id },
  });
  await waitStatus(request, id, 'completed');
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(
    page
      .locator(`[data-thread-id="${id}"]`)
      .locator('..')
      .getByLabel('已完成 · 未读', { exact: true }),
  ).toBeVisible();
  expect(await captured(page)).toHaveLength(0);
  await start(request, id);
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 已完成' }]);
});

test('denied and unsupported browsers keep in-page results usable', async ({ page, request }) => {
  await mockNotifications(page, 'denied');
  await open(page);
  await openNotificationSettings(page);
  await expect(dialog(page)).toContainText('已被浏览器阻止');
  await expect(toggle(page)).toBeDisabled();
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  expect(await captured(page)).toHaveLength(0);
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(window, 'Notification');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(dialog(page)).toContainText('当前浏览器不支持');
  await expect(toggle(page)).toBeDisabled();
  await page.screenshot({ path: join(evidence, 'notifications-unsupported.png') });
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  await expect(
    page
      .locator(`[data-thread-id="${id}"]`)
      .locator('..')
      .getByLabel('已完成 · 未读', { exact: true }),
  ).toBeVisible();
});

test('fails safely when durable deduplication storage is unavailable', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await page.addInitScript(() => {
    Object.defineProperty(indexedDB, 'open', {
      value: () => {
        throw new Error('Storage unavailable');
      },
    });
  });
  await open(page);
  await enable(page);
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  await expect(dialog(page).getByRole('alert')).toContainText('去重记录');
  expect(await captured(page)).toHaveLength(0);
});

for (const [prompt, title, selector, state] of [
  ['[approval]', 'Agent 需要审批', '.action-card', 'waitingApproval'],
  ['[permissions]', 'Agent 需要审批', '.action-card', 'waitingApproval'],
  ['[questions]', 'Agent 需要回答', '.action-card', 'waitingInput'],
  ['[async-questions-running]', 'Agent 需要回答', '.async-question-card', 'running'],
] as const) {
  test(`${prompt} notifies across projects, focuses its card and survives reconnect without another reminder`, async ({
    page,
    context,
    request,
  }) => {
    await mockNotifications(page);
    await open(page);
    await enable(page);
    await page.getByRole('button', { name: '关闭通知设置' }).click();
    const id = await create(request, 'fixture-other', '等待你处理的会话');
    await start(request, id, prompt);
    await waitStatus(request, id, state);
    await expect
      .poll(() => captured(page))
      .toMatchObject([{ title, options: { body: '另一个项目 · 等待你处理的会话' } }]);
    expect(await captured(page)).toHaveLength(1);
    await page.evaluate(() => window.notificationTest.shown[0]!.click());
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
    const card = page.locator(selector).first();
    await expect(card).toBeFocused();
    await expect(card).toBeInViewport();
    if (selector === '.async-question-card') {
      await submit(request, `/api/threads/${id}/rename`, { name: '聚焦时仍在更新的会话' });
      await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('聚焦时仍在更新的会话');
      await expect(card.locator('.async-question-heading')).toBeInViewport();
      await expect
        .poll(async () => {
          const heading = await card.locator('.async-question-heading').boundingBox();
          const sticky = await page.locator('.sticky-prompt').boundingBox();
          return Boolean(heading && (!sticky || heading.y >= sticky.y + sticky.height));
        })
        .toBe(true);
      await page.screenshot({ path: join(deliveryEvidence, 'request-focused-desktop.png') });
    }
    await page.screenshot({ path: join(evidence, `${prompt.slice(1, -1)}-focused.png`) });
    await context.setOffline(true);
    await expect(page.locator('.connection-badge')).not.toHaveText('实时连接正常');
    await context.setOffline(false);
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    await submit(request, `/api/threads/${id}/rename`, { name: '更新标题不会重复提醒' });
    await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('更新标题不会重复提醒');
    expect(await captured(page)).toHaveLength(1);
    await page.reload();
    await expect(page.locator(selector).first()).toBeVisible();
    expect(await captured(page)).toHaveLength(0);
  });
}

test('deduplicates an approval across tabs and handles clicking its old notification after interruption', async ({
  page,
  context,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const other = await context.newPage();
  await mockNotifications(other, 'granted');
  await other.goto('/');
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  const id = await create(request);
  const turnId = await start(request, id, '[approval]');
  await expect
    .poll(async () => (await captured(page)).length + (await captured(other)).length)
    .toBe(1);
  const notified = (await captured(page)).length ? page : other;
  await submit(request, `/api/threads/${id}/interrupt`, { expectedTurnId: turnId });
  await waitStatus(request, id, 'interrupted');
  await notified.evaluate(() => window.notificationTest.shown[0]!.click());
  await expect(notified.locator(`[data-thread-id="${id}"]`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(notified.locator('.turn-heading .status').last()).toHaveText('已中断');
  await expect(notified.locator('.action-card')).toHaveCount(0);
  expect(
    (await captured(page))
      .concat(await captured(other))
      .filter(({ title }) => title === 'Agent 需要审批'),
  ).toHaveLength(1);
});

test('does not notify a request resolved while durable arbitration is in flight', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checking!: () => void;
  const started = new Promise<void>((resolve) => {
    checking = resolve;
  });
  await page.route('**/api/threads/*/attention', async (route) => {
    checking();
    await gate;
    await route.continue();
  });
  const id = await create(request);
  const turnId = await start(request, id, '[approval]');
  await started;
  await submit(request, `/api/threads/${id}/interrupt`, { expectedTurnId: turnId });
  await waitStatus(request, id, 'interrupted');
  release();
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 已中断' }]);
  await page.unroute('**/api/threads/*/attention');
  await openNotificationSettings(page);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  expect((await captured(page)).filter(({ title }) => title === 'Agent 需要审批')).toHaveLength(0);
});

test('answered async questions do not notify again and old notifications open their recorded answer', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const id = await create(request);
  await start(request, id, '[async-questions]');
  await expect
    .poll(async () => (await captured(page)).filter(({ title }) => title === 'Agent 需要回答'))
    .toHaveLength(1);
  await page.evaluate(() =>
    window.notificationTest.shown.find(({ title }) => title === 'Agent 需要回答')!.click(),
  );
  const card = page.locator('.async-question-card');
  await expect(card).toBeFocused();
  await card.getByRole('textbox', { name: '项目名称是什么？：自由回答' }).fill('通知回归项目');
  await card.getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(card).toContainText('已发送回答');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.evaluate(() =>
    window.notificationTest.shown.find(({ title }) => title === 'Agent 需要回答')!.click(),
  );
  await expect(card).toContainText('通知回归项目');
  await expect(card.getByRole('button', { name: '发送回答' })).toHaveCount(0);
  expect((await captured(page)).filter(({ title }) => title === 'Agent 需要回答')).toHaveLength(1);
});

for (const mode of ['disabled', 'denied', 'unsupported', 'failed'] as const) {
  test(`pending requests remain usable with notifications ${mode}`, async ({ page, request }) => {
    await mockNotifications(page, mode === 'denied' ? 'denied' : 'granted');
    await open(page);
    if (mode === 'failed') {
      await enable(page);
      await page.getByRole('button', { name: '关闭通知设置' }).click();
      await page.evaluate(() => {
        window.notificationTest.fail = true;
      });
    } else if (mode === 'unsupported') {
      await page.evaluate(() => {
        Reflect.deleteProperty(window, 'Notification');
      });
    }
    const id = await create(request);
    await start(request, id, '[approval]');
    await waitStatus(request, id, 'waitingApproval');
    await page.locator(`[data-thread-id="${id}"]`).click();
    const card = page.locator('.action-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button').first()).toBeEnabled();
    if (mode === 'failed') {
      await openNotificationSettings(page);
      await expect(dialog(page).getByRole('alert')).toContainText('通知发送失败');
      await page.getByRole('button', { name: '关闭通知设置' }).click();
    }
    await card.getByRole('button').first().click();
    await waitStatus(request, id, 'completed');
    expect(await captured(page)).toHaveLength(0);
  });
}

test('notification clicks dismiss notification settings and mobile navigation before focusing the request', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNotifications(page);
  await open(page);
  await enable(page);
  const id = await create(request, 'fixture-other', '手机上的待回答问题');
  await start(request, id, '[questions]');
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 需要回答' }]);
  await page.evaluate(() => window.notificationTest.shown[0]!.click());
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.action-card')).toBeFocused();
  await expect(page.locator('.action-card')).toBeInViewport();
  await page.screenshot({ path: join(evidence, 'questions-mobile-focused.png') });
});

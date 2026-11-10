import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Operation, ServerMessage, ThreadPage, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';

const headers = { Origin: testOrigin };
const selectedRow = (page: Page) =>
  page.locator('.thread-row').filter({ has: page.locator('.thread-selected') });
const forkButton = (page: Page) =>
  selectedRow(page).getByRole('button', { name: 'Fork 会话', exact: true });
const selectedId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
async function newThread(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  if (await page.getByRole('button', { name: '打开项目与会话' }).isVisible())
    await page.getByRole('button', { name: '打开项目与会话' }).click();
  await createEmptyThread(page);
  await expectThreadReady(page);
  return (await selectedId(page))!;
}
async function finishTurn(page: Page, text: string) {
  const previousTurns = await page.locator('.turn').count();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(previousTurns + 1);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}
async function readThread(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}
async function filterSocket(page: Page, filter: (message: ServerMessage) => ServerMessage | null) {
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = filter(JSON.parse(raw.toString()) as ServerMessage);
      if (message) socket.send(JSON.stringify(message));
    });
  });
}
const isForkReceipt = (message: ServerMessage) =>
  message.type === 'event' &&
  message.kind === 'operation' &&
  (message.payload as Operation).kind === 'thread.fork';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  const threads = (await response.json()) as ThreadPage;
  for (const thread of threads.data) {
    const turn = thread.turns.findLast((entry) =>
      ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
    );
    if (turn)
      await request.post(`/api/threads/${thread.id}/interrupt`, {
        headers,
        data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
      });
  }
});

test('fork preserves history and the source draft, then continues independently', async ({
  page,
  request,
}) => {
  const source = await newThread(page);
  await expect(forkButton(page)).toHaveCount(0);
  await finishTurn(page, '用于 Fork 的原始历史');
  await page.getByRole('textbox', { name: '任务内容' }).fill('原会话尚未发送的草稿');
  await forkButton(page).click();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  const fork = (await selectedId(page))!;
  expect(fork).not.toBe(source);
  await expect(
    page.locator('.conversation-content').getByText('用于 Fork 的原始历史', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('');
  await finishTurn(page, '仅在 Fork 会话继续');
  expect((await readThread(request, fork)).turns).toHaveLength(2);
  expect((await readThread(request, source)).turns).toHaveLength(1);
  await page.getByRole('button', { name: '返回原会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('原会话尚未发送的草稿');
  await expect(
    page.locator('.conversation-content').getByText('仅在 Fork 会话继续', { exact: true }),
  ).toHaveCount(0);
  expect(await selectedId(page)).toBe(source);
});

for (const width of [1280, 390, 320]) {
  test(`fork sits next to archive at ${width}px`, async ({ page }) => {
    await newThread(page);
    await finishTurn(page, '请为项目增加运行状态面板，并整理交互细节与验收步骤');
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    if (width < 760) await page.getByRole('button', { name: '打开项目与会话' }).click();
    const row = selectedRow(page);
    const fork = forkButton(page);
    const archive = row.getByRole('button', { name: '归档会话', exact: true });
    await expect(fork).toBeEnabled();
    await expect(fork).toHaveAccessibleDescription(
      'Fork 会话：复制已保存的历史，新会话可与原会话同时执行。',
    );
    await expect(
      page.locator('.topbar').getByRole('button', { name: 'Fork 会话', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.thread-actions')).toHaveCount(0);
    // Wait for the mobile drawer's entrance transition before comparing positions.
    await archive.hover();
    const forkBox = (await fork.boundingBox())!;
    const archiveBox = (await archive.boundingBox())!;
    expect(forkBox.width).toBe(archiveBox.width);
    expect(forkBox.height).toBe(archiveBox.height);
    expect(archiveBox.x - forkBox.x - forkBox.width).toBeLessThanOrEqual(2);
    expect(archiveBox.y).toBe(forkBox.y);
    expect(archiveBox.x + archiveBox.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: `/tmp/codex-issue-100/sidebar-after-${width}.png`,
      animations: 'disabled',
    });
    await fork.focus();
    await fork.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText('Fork 会话');
    await page.keyboard.press('Escape');
    await fork.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText('复制已保存的历史');
    await page.screenshot({
      path: `/tmp/codex-issue-100/sidebar-tooltip-${width}.png`,
      animations: 'disabled',
    });
    await fork.press('Enter');
    await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
    if (width < 760) await expect(page.locator('.sidebar')).not.toBeInViewport();
  });
}

test.describe('touch sidebar', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 844 } });
  test('fork and archive have matching touch targets and tapping fork closes navigation', async ({
    page,
  }) => {
    await newThread(page);
    await finishTurn(page, '触屏 Fork 操作');
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    const fork = forkButton(page);
    const archive = selectedRow(page).getByRole('button', { name: '归档会话', exact: true });
    for (const button of [fork, archive]) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBe(32);
      expect(box.height).toBe(44);
    }
    await page.screenshot({
      path: '/tmp/codex-issue-100/sidebar-touch-320.png',
      animations: 'disabled',
    });
    await fork.tap();
    await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar')).not.toBeInViewport();
  });
});

for (const recover of [false, true]) {
  test(`forks an unselected ${recover ? 'other-project conversation after reload' : 'conversation'} without resuming it`, async ({
    page,
    request,
  }) => {
    if (recover) await filterSocket(page, (message) => (isForkReceipt(message) ? null : message));
    const selected = await newThread(page);
    await finishTurn(page, '当前会话历史');
    await page.getByRole('textbox', { name: '任务内容' }).fill('当前会话的草稿');
    const projectId = recover ? 'fixture-other' : 'fixture';
    const created = await request.post(`/api/projects/${projectId}/threads`, {
      headers,
      data: { clientOperationId: randomUUID() },
    });
    const source = ((await created.json()).result as { threadId: string }).threadId;
    await request.post(`/api/threads/${source}/turns`, {
      headers,
      data: { clientOperationId: randomUUID(), text: '未打开的会话历史 [title-fail]' },
    });
    await expect
      .poll(async () => (await readThread(request, source)).turns.at(-1)?.status)
      .toBe('completed');
    const sourceRow = page
      .locator('.thread-row')
      .filter({ has: page.locator(`[data-thread-id="${source}"]`) });
    await expect(sourceRow).toBeVisible();
    const resumes: string[] = [];
    let submissions = 0;
    let withhold = recover;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/threads/${source}/resume`))
        resumes.push(request.url());
    });
    await page.route(`**/api/threads/${source}/fork`, async (route) => {
      submissions++;
      expect(route.request().postDataJSON().settings).toBeUndefined();
      if (recover) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    if (recover)
      await page.route('**/api/operations/*', (route) =>
        withhold
          ? route.fulfill({
              status: 503,
              json: { error: { code: 'UNAVAILABLE', message: '暂时无法核对' } },
            })
          : route.continue(),
      );
    await sourceRow.getByRole('button', { name: 'Fork 会话', exact: true }).click();
    if (recover) {
      await expect(
        sourceRow.getByRole('button', { name: '正在确认 Fork…', exact: true }),
      ).toBeDisabled();
      expect(await selectedId(page)).toBe(selected);
      withhold = false;
      await page.reload();
    }
    await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('codex-web.project')))
      .toBe(projectId);
    const resultId = await page.evaluate(
      (id) => localStorage.getItem(`codex-web.selected:${id}`),
      projectId,
    );
    expect((await readThread(request, resultId!)).forkedFromId).toBe(source);
    expect(submissions).toBe(1);
    expect(resumes).toEqual([]);
    await page.locator(`[data-thread-id="${selected}"]`).click();
    await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue(
      recover ? '' : '当前会话的草稿',
    );
  });
}

test('disabled fork keeps its explanation next to archive', async ({ page, request }) => {
  await newThread(page);
  await finishTurn(page, '检查不可用状态下的 Fork 提示');
  await controlRuntime(request, { unavailable: true });
  await page
    .getByRole('dialog', { name: 'Codex 版本兼容性未经验证' })
    .getByRole('button', { name: '暂不使用', exact: true })
    .click();
  const fork = forkButton(page);
  await expect(fork).toBeDisabled();
  await expect(fork).toHaveAccessibleDescription('连接恢复且 Codex 就绪后可 Fork 会话。');
  await selectedRow(page).locator('.thread-fork').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    '连接恢复且 Codex 就绪后可 Fork 会话。',
  );
});

test('fork runs in the shared checkout while the source waits for approval', async ({
  page,
  request,
}) => {
  const source = await newThread(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('[approval] 原会话继续等待批准');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await forkButton(page).click();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已中断');
  await expect(page.locator('.action-card')).toHaveCount(0);
  const original = await readThread(request, source);
  expect(original.status).toBe('waitingApproval');
  expect(original.actions.some((action) => action.status === 'pending')).toBe(true);
  await page.getByRole('textbox', { name: '任务内容' }).fill('与原任务同时执行');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.error-banner.dismissible')).not.toBeVisible();
  expect((await readThread(request, source)).status).toBe('waitingApproval');
});

test('an unknown source submission can fork without resending the source operation', async ({
  page,
}) => {
  await newThread(page);
  await finishTurn(page, '未知提交前的已保存历史');
  let sourceSubmissions = 0;
  await page.route('**/api/threads/*/turns', async (route) => {
    sourceSubmissions++;
    await route.abort('failed');
  });
  await page.getByRole('textbox', { name: '任务内容' }).fill('回执未知的任务');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.pending-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await expect(forkButton(page)).toBeEnabled();
  await page.locator('.pending-notice').getByRole('button', { name: 'Fork 为新会话' }).click();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  await expect(
    page.locator('.conversation-content').getByText('未知提交前的已保存历史', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('回执未知的任务', { exact: true })).toHaveCount(0);
  expect(sourceSubmissions).toBe(1);
});

test('a known fork failure keeps the source and its draft selected', async ({ page }) => {
  const source = await newThread(page);
  await finishTurn(page, '失败测试前的历史');
  await page.getByRole('textbox', { name: '任务内容' }).fill('失败时保留的草稿');
  await page.route('**/api/threads/*/fork', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_RPC_ERROR', message: '测试 Fork 失败' } },
    }),
  );
  await forkButton(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('测试 Fork 失败');
  await expect(forkButton(page)).toBeEnabled();
  expect(await selectedId(page)).toBe(source);
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('失败时保留的草稿');
});

test('lost fork receipts recover after reload without dispatching a duplicate', async ({
  page,
  request,
}) => {
  let withhold = true;
  let submissions = 0;
  await filterSocket(page, (message) => (isForkReceipt(message) ? null : message));
  await page.route('**/api/operations/*', async (route) => {
    if (withhold)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '暂时无法核对' } },
      });
    else await route.continue();
  });
  const source = await newThread(page);
  await finishTurn(page, '丢失 Fork 回执时的原始历史');
  await page.route('**/api/threads/*/fork', async (route) => {
    submissions++;
    await route.fetch();
    await route.abort('failed');
  });
  await forkButton(page).click();
  await expect(page.locator('.pending-notice')).toContainText('复制会话');
  await expect(page.getByRole('button', { name: '正在确认 Fork…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '正在确认 Fork…', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.mouse.move(0, 0);
  await selectedRow(page).locator('.thread-fork').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText('正在确认 Fork');
  await page.screenshot({
    path: '/tmp/codex-issue-100/sidebar-pending.png',
    animations: 'disabled',
  });
  expect(await selectedId(page)).toBe(source);
  withhold = false;
  // Recover the operation before the first project snapshot arrives, as can happen on CI
  // and slow connections. Navigation must wait for the owning project to be restored.
  await page.route('**/api/projects', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  expect(await selectedId(page)).not.toBe(source);
  await expect(
    page.locator('.conversation-content').getByText('丢失 Fork 回执时的原始历史', { exact: true }),
  ).toHaveCount(1);
  expect(submissions).toBe(1);
  expect((await readThread(request, source)).turns).toHaveLength(1);
});

test('RESULT_UNKNOWN 409 remains durable and blocks another fork after reload', async ({
  page,
}) => {
  const source = await newThread(page);
  let submissions = 0;
  await finishTurn(page, '未知 Fork 结果前的历史');
  await page.route('**/api/threads/*/fork', async (route) => {
    submissions++;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'RESULT_UNKNOWN', message: 'Fork 可能已完成，等待核对' } },
    });
  });
  await forkButton(page).click();
  await expect(page.locator('.pending-notice')).toContainText('复制会话');
  await page.reload();
  await expect(page.locator('.pending-notice')).toContainText('复制会话');
  await expect(page.getByRole('button', { name: '正在确认 Fork…', exact: true })).toBeDisabled();
  expect(await selectedId(page)).toBe(source);
  expect(submissions).toBe(1);
});

test('a late fork receipt adds the result without taking over a newly selected conversation', async ({
  page,
  request,
}) => {
  await filterSocket(page, (message) => (isForkReceipt(message) ? null : message));
  let withhold = true;
  await page.route('**/api/operations/*', async (route) => {
    if (withhold)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '延后核对' } },
      });
    else await route.continue();
  });
  const source = await newThread(page);
  await finishTurn(page, '迟到回执前的原会话历史');
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const forked = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route('**/api/threads/*/fork', async (route) => {
    const response = await route.fetch();
    completed();
    await delayed;
    await route.fulfill({ response });
  });
  await forkButton(page).click();
  await forked;
  const other = await request.post('/api/projects/fixture/threads', {
    headers,
    data: { clientOperationId: randomUUID() },
  });
  const otherId = ((await other.json()) as Operation).result as { threadId: string };
  await request.post(`/api/threads/${otherId.threadId}/turns`, {
    headers,
    data: { clientOperationId: randomUUID(), text: '另一个已开始的会话 [title-fail]' },
  });
  await expect
    .poll(async () => (await readThread(request, otherId.threadId)).turns[0]?.status)
    .toBe('completed');
  await page.getByRole('button', { name: '刷新会话列表', exact: true }).click();
  await page.locator(`[data-thread-id="${otherId.threadId}"]`).click();
  await expect.poll(() => selectedId(page)).toBe(otherId.threadId);
  const receipt = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/fork'),
  );
  withhold = false;
  release();
  const result = ((await (await receipt).json()) as Operation).result as { threadId: string };
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('codex-web.operations.v1') ?? '[]').length,
      ),
    )
    .toBe(0);
  await expect(page.locator('.turn')).toHaveCount(1);
  for (const id of [source, otherId.threadId, result.threadId])
    await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  expect(await selectedId(page)).toBe(otherId.threadId);
});

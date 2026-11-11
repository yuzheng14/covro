import { expect, test, type Page } from '@playwright/test';
import type { Operation, ServerMessage } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';

const panel = (page: Page) => page.getByRole('region', { name: '状态诊断详情' });
const checkButton = (page: Page) =>
  page.locator('.pending-notice').getByRole('button', { name: '核对提交', exact: true });
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

async function completedThread(page: Page, text = '核对状态回归测试') {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await input(page).fill(text);
  const response = page.waitForResponse(
    (entry) => entry.request().method() === 'POST' && entry.url().endsWith('/turns'),
  );
  await send(page).click();
  const operation = (await (await response).json()) as Operation;
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  return operation;
}

test('checking refreshes unknown history even with no saved browser operations', async ({
  page,
}) => {
  const operation = await completedThread(page);
  let stale = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/threads/${operation.target}`, async (route) => {
    const response = await route.fetch();
    if (!stale) await gate;
    await route.fulfill({
      response,
      json: { ...(await response.json()), ...(stale ? { status: 'unknown' } : {}) },
    });
  });
  await page.route(`**/api/threads/${operation.target}/snapshot`, async (route) => {
    const response = await route.fetch();
    if (!stale) await gate;
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        data: { ...snapshot.data, ...(stale ? { status: 'unknown' } : {}) },
      },
    });
  });
  // Keep the stale HTTP snapshot visible until the explicit history read.
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (
        message.type !== 'snapshot' &&
        !(message.type === 'event' && ['thread', 'threadPatch'].includes(message.kind))
      )
        socket.send(raw);
    });
  });
  await page.evaluate(() => localStorage.removeItem('codex-web.operations.v1'));
  await page.reload();
  await expect(checkButton(page)).toBeVisible();
  await input(page).fill('核对后继续的草稿');
  await expect(send(page)).toBeDisabled();
  stale = false;
  await checkButton(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toBeFocused();
  await expect(panel(page).getByText('正在核对会话历史和提交回执…')).toBeVisible();
  await expect(
    page.locator('.pending-notice').getByRole('button', { name: '正在核对…' }),
  ).toBeDisabled();
  release();
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  await expect(panel(page).getByText('没有待核对的提交。')).toBeVisible();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('核对后继续的草稿');
});

for (const mobile of [false, true]) {
  test(`unloaded managed history recovers automatically through Codex and the real gateway (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }, testInfo) => {
    const operation = await completedThread(page, '[unload] 已完成后卸载的会话');
    // Let the normal receipt poll remove the finished operation. No HTTP or WebSocket
    // response is mocked: the fixture emits a real notLoaded protocol notification.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('codex-web.operations.v1')))
      .toBe('[]');
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await input(page).fill('恢复后继续的草稿');
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    await expect(page.locator('.topbar .status')).toHaveText('已完成');
    await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('恢复后继续的草稿');
    expect(posts).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath(`recovered-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await send(page).click();
    await expect(page.locator('.turn')).toHaveCount(2);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    expect(posts).toEqual([expect.stringContaining(`/api/threads/${operation.target}/turns`)]);
  });

  test(`unknown receipt opens manual reconciliation and refreshes its result (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }, testInfo) => {
    const operation = await completedThread(page);
    await page.route(`**/api/operations/${operation.clientOperationId}`, async (route) => {
      const response = await route.fetch();
      const receipt = (await response.json()) as Operation;
      // An uncertain receipt stays unknown even after human reconciliation.
      // Withhold terminal evidence until then: confirmed-ended executions no longer block.
      await route.fulfill({
        response,
        json: {
          ...receipt,
          status: 'unknown',
          execution: receipt.execution && {
            ...receipt.execution,
            ended: Boolean(receipt.reconciliation),
          },
        },
      });
    });
    await page.evaluate((receipt) => {
      localStorage.setItem(
        'codex-web.operations.v1',
        JSON.stringify([
          {
            clientOperationId: receipt.clientOperationId,
            kind: 'send',
            target: receipt.target,
            createdAt: receipt.createdAt,
          },
        ]),
      );
    }, operation);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    else await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(checkButton(page)).toBeVisible();
    const submissions: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') submissions.push(request.url());
    });
    await input(page).fill('核对期间保留的草稿');
    await checkButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
    const reconcile = panel(page).getByRole('button', { name: '恢复此会话的操作…' });
    await expect(reconcile).toBeEnabled();
    expect(submissions).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath(`reconciliation-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await reconcile.click();
    const recovery = page.getByRole('dialog', { name: '恢复此会话的操作' });
    await expect(recovery).toContainText('不会停止任务或重新发送');
    await recovery.getByRole('button', { name: '确认旧任务已结束并恢复' }).click();
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    await expect(panel(page).locator('.operation-card')).toHaveCount(0);
    await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('核对期间保留的草稿');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain(`/api/operations/${operation.clientOperationId}/reconcile`);
    // The native summary still closes and reopens the panel after the banner opened it.
    await page.locator('.diagnostics > summary').click();
    await expect(panel(page)).not.toBeVisible();
    await page.locator('.diagnostics > summary').click();
    await expect(panel(page)).toBeVisible();
  });
}

test('a failed receipt lookup is visible and retry does not resubmit the task', async ({
  page,
}) => {
  await completedThread(page);
  let submissions = 0;
  let uncertainOperationId = '';
  await page.route('**/api/threads/*/turns', async (route) => {
    submissions++;
    uncertainOperationId = route.request().postDataJSON().clientOperationId;
    await route.abort('failed');
  });
  await page.route('**/api/operations/*', (route) => {
    if (!route.request().url().endsWith(`/${uncertainOperationId}`)) return route.continue();
    return route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '核对服务暂时不可用' } },
    });
  });
  await input(page).fill('回执丢失时保留的草稿');
  await send(page).click();
  await checkButton(page).click();
  await expect(
    panel(page).getByText('暂时无法查询这次提交的结果，请恢复连接后重试。'),
  ).toBeVisible();
  await expect(page.locator('.pending-notice')).toContainText('暂时无法查询这次提交的结果');
  await expect(panel(page).getByRole('button', { name: '解除本页限制…' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await panel(page).getByRole('button', { name: '刷新状态' }).click();
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await expect(send(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('回执丢失时保留的草稿');
  expect(submissions).toBe(1);
});

for (const mobile of [false, true]) {
  test(`missing receipt reports a real 404 and permits confirmed browser-only cleanup (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
    request,
  }, testInfo) => {
    await completedThread(page);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const posts: string[] = [];
    let missingId = '';
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST') posts.push(outgoing.url());
    });
    await page.route('**/api/threads/*/turns', async (route) => {
      missingId = route.request().postDataJSON().clientOperationId;
      await route.abort('failed'); // Browser identity persists, but no server operation is created.
    });
    await input(page).fill('尚未送达服务的任务草稿');
    const missing = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/operations/${missingId}`) && response.status() === 404,
    );
    await send(page).click();
    expect(await (await missing).json()).toEqual({
      error: { code: 'OPERATION_NOT_FOUND', message: '未找到该操作' },
    });
    await expect(page.locator('.pending-notice')).toContainText('服务端找不到这次提交记录');
    await expect(send(page)).toBeDisabled();
    // A reload must preserve the uncertain identity and query it again, never assume failure.
    await page.screenshot({
      path: testInfo.outputPath(`missing-receipt-banner-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(checkButton(page)).toBeVisible();
    await input(page).fill('核对后仍保留的草稿');
    await checkButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(
      panel(page).getByText('服务端找不到这次提交记录，暂时无法确认结果。'),
    ).toBeVisible();
    await expect(page.locator('.error-banner.dismissible')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: '核对并解除旧占用' })).toHaveCount(0);
    const discard = panel(page).getByRole('button', { name: '解除本页限制…' });
    await expect(discard).toBeEnabled();
    await expect(send(page)).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath(`missing-receipt-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await discard.click();
    const clear = page.getByRole('dialog', { name: '解除本页限制' });
    await expect(clear).toContainText('再次提交可能重复执行');
    await clear.getByRole('button', { name: '解除本页限制', exact: true }).click();
    await expect(panel(page).getByText('没有待核对的提交。')).toBeVisible();
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    await expect(page.locator('.error-banner.dismissible')).toHaveCount(0);
    await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('核对后仍保留的草稿');
    expect(posts).toHaveLength(1); // No resend, reconciliation POST, or server-side deletion.
    expect((await request.get(`/api/operations/${missingId}`)).status()).toBe(404);
    await page.reload();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await input(page).fill('刷新后可继续的新任务');
    await expect(send(page)).toBeEnabled();
    await expect(page.locator('.pending-notice')).toHaveCount(0);
  });
}

test('an in-flight submission is not polled as a missing receipt', async ({ page }) => {
  await completedThread(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pendingId = '';
  const lookups: string[] = [];
  await page.route('**/api/threads/*/turns', async (route) => {
    pendingId = route.request().postDataJSON().clientOperationId;
    await gate;
    await route.continue();
  });
  page.on('request', (outgoing) => {
    if (pendingId && outgoing.url().endsWith(`/api/operations/${pendingId}`))
      lookups.push(outgoing.url());
  });
  await input(page).fill('正在发送中的任务');
  await send(page).click();
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  await page.locator('.diagnostics > summary').click();
  await panel(page).getByRole('button', { name: '刷新状态' }).click();
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  expect(lookups).toHaveLength(0);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '解除本页限制…' })).toHaveCount(0);
  release();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.pending-notice')).toHaveCount(0);
});

test('a late 404 cannot replace a receipt delivered through the live stream', async ({
  page,
  request,
}) => {
  const first = await completedThread(page);
  let missingId = '';
  await page.route('**/api/threads/*/turns', async (route) => {
    missingId = route.request().postDataJSON().clientOperationId;
    await route.abort('failed');
  });
  await input(page).fill('稍后才到达网关的任务');
  await send(page).click();
  await expect(page.locator('.pending-notice')).toContainText('服务端找不到这次提交记录');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  await page.route(`**/api/operations/${missingId}`, async (route) => {
    const response = await route.fetch();
    readStarted();
    await gate;
    await route.fulfill({ response });
  });
  await checkButton(page).click();
  await reading;
  // Simulate delayed delivery of the original identity while its older read is in flight.
  const delivered = await request.post(`/api/threads/${first.target}/turns`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: missingId, text: '[approval] 等待人工处理' },
  });
  expect(delivered.ok()).toBe(true);
  await expect(
    panel(page).getByText('这个会话的任务仍在运行，请前往会话查看或停止任务。'),
  ).toBeVisible();
  release();
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.error-banner.dismissible')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '解除本页限制…' })).toHaveCount(0);
});

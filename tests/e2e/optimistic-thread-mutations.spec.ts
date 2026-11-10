import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, projectGroup, testOrigin } from './helpers';

const row = (page: Page, id: string) =>
  page.locator('.thread-row').filter({ has: page.locator(`[data-thread-id="${id}"]`) });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function seed(page: Page, request: APIRequestContext) {
  await page.goto('/');
  await confirmCompatibility(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('归档操作验证 [title-fail]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const id = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  const created = await request.post('/api/projects/fixture/threads', {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  const other = (await created.json()).result.threadId as string;
  return { id, other };
}
const screenshot = (page: Page, name: string) =>
  page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('archive and restore update immediately while requests are held, preserving draft and filters', async ({
  page,
  request,
}) => {
  const { id } = await seed(page, request);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保留这份草稿');
  await screenshot(page, 'archive-before');
  let blocked = gate();
  let writes = 0;
  const path = `**/api/threads/${id}/archive`;
  await page.route(path, async (route) => {
    writes++;
    await blocked.promise;
    await route.continue();
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(row(page, id)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '开始你的下一项任务' })).toBeVisible();
  await expect(page.locator('.mutation-notice')).toHaveText('正在归档会话…');
  await screenshot(page, 'archive-pending');
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(row(page, id)).toBeVisible();
  await expect(row(page, id).getByRole('button', { name: '取消归档', exact: true })).toBeDisabled();
  blocked.release();
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  await row(page, id).locator('.thread-link').click();
  await expect(page.locator('.archive-notice').filter({ hasText: '此会话已归档' })).toBeVisible();
  blocked = gate();
  await page
    .locator('.archive-notice')
    .getByRole('button', { name: '取消归档', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(row(page, id)).toBeVisible();
  await expect(page.locator('.mutation-notice')).toHaveText('正在取消归档…');
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '保留这份草稿',
  );
  await screenshot(page, 'unarchive-pending');
  blocked.release();
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await screenshot(page, 'archive-synchronized');
  expect(writes).toBe(2);
});

test('a definite rejection restores only the archived row and its original draft', async ({
  page,
  request,
}) => {
  const { id } = await seed(page, request);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('失败也保留的草稿');
  const blocked = gate();
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    await blocked.promise;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'THREAD_BUSY', message: '会话现在有任务，归档被拒绝' } },
    });
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(row(page, id)).toHaveCount(0);
  blocked.release();
  await expect(page.locator('.error-banner.dismissible')).toContainText('归档被拒绝');
  await expect(row(page, id).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '失败也保留的草稿',
  );
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  await screenshot(page, 'archive-rollback');
});

test('a lost receipt remains pending across reload and reconciles the same operation without resending', async ({
  page,
  request,
}) => {
  const { id } = await seed(page, request);
  let writes = 0;
  await page.route('**/api/operations/*', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'OPERATION_NOT_FOUND', message: '回执暂时不可查' } },
    }),
  );
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    writes++;
    await route.fetch();
    await route.abort('failed');
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(page.locator('.mutation-notice')).toContainText('归档结果待确认');
  const operations = await page.evaluate(() => localStorage.getItem('codex-web.operations.v1'));
  await screenshot(page, 'archive-unknown');
  await page.reload();
  await expect(page.locator('.mutation-notice')).toContainText('归档结果待确认');
  await expect(row(page, id)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('codex-web.operations.v1'))).toBe(
    operations,
  );
  await page.unroute('**/api/operations/*');
  await page.locator('.mutation-notice').getByRole('button', { name: '核对提交' }).click();
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  expect(writes).toBe(1);
});

test('a late failure does not take navigation back from another project', async ({
  page,
  request,
}) => {
  const { id } = await seed(page, request);
  const blocked = gate();
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    await blocked.promise;
    await route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_REQUEST_FAILED', message: '归档失败' } },
    });
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await projectGroup(page, '另一个项目').locator('.project-link').click();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('另一个项目的草稿');
  blocked.release();
  await expect(page.locator('.error-banner.dismissible')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '另一个项目的草稿',
  );
  await expect(projectGroup(page, '另一个项目').locator('.project-link')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(row(page, id)).toBeVisible();
  await row(page, id).locator('[data-thread-id]').click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('归档失败');
});

test('an explicitly reconciled unknown receipt clears its projection without retaining a pending notice', async ({
  page,
  request,
}) => {
  const { id } = await seed(page, request);
  let operationId = '';
  let reconciled = false;
  const receipt = () => ({
    clientOperationId: operationId,
    kind: 'thread.archive',
    target: id,
    status: 'unknown',
    createdAt: 1,
    updatedAt: 2,
    ...(reconciled ? { reconciliation: { at: 3, decision: 'confirmed' } } : {}),
  });
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    operationId = route.request().postDataJSON().clientOperationId;
    await route.fulfill({ json: receipt() });
  });
  await page.route('**/api/operations/*', (route) => route.fulfill({ json: receipt() }));
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(page.locator('.mutation-notice')).toContainText('归档结果待确认');
  reconciled = true;
  await page.locator('.mutation-notice').getByRole('button', { name: '核对提交' }).click();
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  await expect(row(page, id)).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('codex-web.operations.v1') ?? '[]'),
  );
  expect(
    saved.find((entry: { clientOperationId: string }) => entry.clientOperationId === operationId),
  ).toBeUndefined();
});

test('restored unselected history subscribes from a fresh snapshot instead of replaying an obsolete visit', async ({
  page,
  request,
}) => {
  const subscriptions: { type: string; threadId?: string; after?: unknown }[] = [];
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      subscriptions.push(JSON.parse(raw.toString()));
      server.send(raw);
    });
  });
  const { id } = await seed(page, request);
  await projectGroup(page).locator('.project-link').click();
  await expect.poll(() => subscriptions.at(-1)?.type).toBe('unsubscribe');
  for (const archived of [true, false]) {
    const response = await request.post(`/api/threads/${id}/archive`, {
      headers: { Origin: testOrigin },
      data: { clientOperationId: randomUUID(), archived },
    });
    expect(response.ok()).toBe(true);
    if (archived) await expect(row(page, id)).toHaveCount(0);
    else await expect(row(page, id)).toBeVisible();
  }
  const before = subscriptions.filter((entry) => entry.threadId === id).length;
  await row(page, id).locator('.thread-link').click();
  await expect
    .poll(() => subscriptions.filter((entry) => entry.threadId === id).length)
    .toBe(before + 1);
  expect(subscriptions.filter((entry) => entry.threadId === id).at(-1)?.after).toBeUndefined();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('恢复后可以继续工作');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, createEmptyThread, testOrigin } from './helpers';

const headers = { Origin: testOrigin };
const panel = (page: Page) => page.getByRole('region', { name: '状态诊断详情' });
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await input(page).fill('当前会话的已有历史 [title-fail]');
  await send(page).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

async function namedThread(request: APIRequestContext, project: string, name: string) {
  const created = await request.post(`/api/projects/${project}/threads`, {
    headers,
    data: { clientOperationId: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as Operation).result as { threadId: string };
  const renamed = await request.post(`/api/threads/${id.threadId}/rename`, {
    headers,
    data: { clientOperationId: randomUUID(), name },
  });
  expect(renamed.ok()).toBe(true);
  const sent = await request.post(`/api/threads/${id.threadId}/turns`, {
    headers,
    data: { clientOperationId: randomUUID(), text: `${name} [approval]` },
  });
  expect(sent.ok()).toBe(true);
  return (await sent.json()) as Operation;
}

for (const mobile of [false, true]) {
  test(`identifies other conversations without offering recovery against the selected conversation (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
    request,
  }, info) => {
    const first = await namedThread(request, 'fixture', '整理发布计划');
    const second = await namedThread(request, 'fixture-other', '检查仓库依赖');
    await page.evaluate(
      (receipts) =>
        localStorage.setItem(
          'codex-web.operations.v1',
          JSON.stringify(
            receipts.map((receipt) => ({
              clientOperationId: receipt.clientOperationId,
              kind: 'send',
              target: receipt.target,
              createdAt: receipt.createdAt,
            })),
          ),
        ),
      [first, second],
    );
    await page.reload();
    await expect(page.locator('.turn')).toHaveCount(1);
    await input(page).fill('当前会话可以正常发送');
    await expect(send(page)).toBeEnabled();
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.locator('.diagnostics > summary').click();
    const others = panel(page).getByRole('region', { name: '其他会话与操作' });
    // section landmarks require an accessible name; each card names the real source conversation.
    const firstCard = others.getByRole('article', { name: '发送消息 · 整理发布计划' });
    const secondCard = others.getByRole('article', { name: '发送消息 · 检查仓库依赖' });
    await expect(firstCard).toContainText('测试项目');
    await expect(secondCard).toContainText('另一个项目');
    await expect(others.getByRole('button', { name: /恢复此会话的操作/ })).toHaveCount(0);
    await expect(firstCard.locator('.raw-details')).not.toHaveAttribute('open');
    expect(await firstCard.innerText()).not.toContain(first.clientOperationId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const path = info.outputPath(`conversation-ownership-${mobile ? 'mobile' : 'desktop'}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach('conversation ownership', { path, contentType: 'image/png' });
    await secondCard.getByRole('button', { name: '打开会话' }).click();
    await expect(page.locator('.topbar')).toContainText('检查仓库依赖');
    await expect(page.locator('.action-card')).toHaveCount(1);
    await expect(page.locator('.error-banner.dismissible')).toHaveCount(0);
    await page.locator('.diagnostics > summary').click();
    const current = panel(page).getByRole('article', { name: '发送消息 · 检查仓库依赖' });
    await expect(current).toContainText('仍在运行');
    await expect(current.getByRole('button', { name: /恢复此会话的操作/ })).toHaveCount(0);
  });
}

test('explains and clears a missing approval receipt next to the blocked approval without submitting a decision', async ({
  page,
  request,
}, info) => {
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await request.post(`/api/threads/${id}/rename`, {
    headers,
    data: { clientOperationId: randomUUID(), name: '审批恢复演示' },
  });
  const started = await request.post(`/api/threads/${id}/turns`, {
    headers,
    data: { clientOperationId: randomUUID(), text: '等待审批 [approval]' },
  });
  expect(started.ok()).toBe(true);
  await expect(page.locator('.action-card')).toHaveCount(1);
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  const action = thread.actions.find((entry) => entry.status === 'pending')!;
  const missing = randomUUID();
  await page.evaluate(
    ({ missing, action }) =>
      localStorage.setItem(
        'codex-web.operations.v1',
        JSON.stringify([
          {
            clientOperationId: missing,
            kind: 'resolve',
            target: action.actionId,
            createdAt: Date.now(),
          },
        ]),
      ),
    { missing, action },
  );
  await page.reload();
  const approve = page
    .locator('.action-card')
    .getByRole('button', { name: '允许本次', exact: true });
  await expect(approve).toBeDisabled();
  const notice = page.locator('.action-recovery-group .recovery-notice');
  await expect(notice).toContainText('服务端找不到这次提交记录');
  const posts: string[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST') posts.push(outgoing.url());
  });
  await notice.getByRole('button', { name: '查看处理方式' }).click();
  const card = panel(page).getByRole('article', { name: '处理审批或输入 · 审批恢复演示' });
  await expect(card).toBeFocused();
  await card.getByRole('button', { name: '解除本页限制…' }).click();
  const dialog = page.getByRole('dialog', { name: '解除本页限制' });
  await expect(dialog).toContainText('审批恢复演示');
  await expect(dialog).toContainText('不会停止任务或重新发送');
  const path = info.outputPath('approval-recovery.png');
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach('approval recovery', { path, contentType: 'image/png' });
  await dialog.getByRole('button', { name: '解除本页限制', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(approve).toBeEnabled();
  expect(posts).toHaveLength(0);
  await page.locator('.diagnostics > summary').click();
  await approve.click();
  await expect(page.locator('.action-card')).toHaveCount(0);
  expect(
    posts.filter((url) => url.includes(`/api/actions/${action.actionId}/resolve`)),
  ).toHaveLength(1);
});

test('silently removes an uncertain receipt with terminal evidence after reload and keeps the draft', async ({
  page,
  request,
}, info) => {
  await input(page).fill('自动恢复验证');
  const response = page.waitForResponse(
    (entry) => entry.url().endsWith('/turns') && entry.request().method() === 'POST',
  );
  await send(page).click();
  const receipt = (await (await response).json()) as Operation;
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.route(`**/api/operations/${receipt.clientOperationId}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), status: 'unknown' } });
  });
  await page.evaluate(
    (receipt) =>
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
      ),
    receipt,
  );
  const posts: string[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST') posts.push(outgoing.url());
  });
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(2);
  await input(page).fill('继续处理下一件事');
  await expect(send(page)).toBeEnabled();
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('codex-web.operations.v1')))
    .toBe('[]');
  expect(posts).toHaveLength(0);
  expect((await request.get(`/api/operations/${receipt.clientOperationId}`)).ok()).toBe(true);
  const path = info.outputPath('automatically-recovered.png');
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach('automatic recovery', { path, contentType: 'image/png' });
});

test('removes an old approval record after the same approval was handled elsewhere without enabling it again', async ({
  page,
  request,
}) => {
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const started = await request.post(`/api/threads/${id}/turns`, {
    headers,
    data: { clientOperationId: randomUUID(), text: '在另一个标签页处理 [approval]' },
  });
  expect(started.ok()).toBe(true);
  await expect(page.locator('.action-card')).toHaveCount(1);
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  const action = thread.actions.find((entry) => entry.status === 'pending')!;
  const savedId = randomUUID();
  await page.evaluate(
    ({ id, savedId, action }) =>
      localStorage.setItem(
        'codex-web.operations.v1',
        JSON.stringify([
          {
            clientOperationId: savedId,
            kind: 'resolve',
            target: action.actionId,
            createdAt: Date.now(),
            context: { threadId: id, projectId: 'fixture', title: '已处理的审批' },
          },
        ]),
      ),
    { id, savedId, action },
  );
  const answered = await request.post(`/api/actions/${action.actionId}/resolve`, {
    headers,
    data: { clientOperationId: randomUUID(), resolution: { decision: 'accept' } },
  });
  expect(answered.ok()).toBe(true);
  const posts: string[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST') posts.push(outgoing.url());
  });
  await page.reload();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.action-card')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (savedId) =>
          JSON.parse(localStorage.getItem('codex-web.operations.v1') ?? '[]').some(
            (entry: { clientOperationId: string }) => entry.clientOperationId === savedId,
          ),
        savedId,
      ),
    )
    .toBe(false);
  expect(posts).toHaveLength(0);
});

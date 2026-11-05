import { expect, test, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadPage, ThreadView } from '../../src/shared/types';
import {
  chooseSelectOption,
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';

const headers = { Origin: testOrigin };
const evidence = join(tmpdir(), 'codex-permissions-evidence');
const labelEvidence = join(tmpdir(), 'codex-issue-67-evidence');
test.use({ viewport: { width: 1280, height: 1400 } });
const isResolution = (request: Request) =>
  request.method() === 'POST' && /\/api\/actions\/[^/]+\/resolve$/.test(request.url());
async function pendingTask(page: Page, prompt: string) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createEmptyThread(page);
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function assertWaiting(page: Page, threadId: string) {
  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.ok()).toBe(true);
  const thread = (await response.json()) as ThreadView;
  expect(thread.actions.filter((action) => action.status === 'pending')).toHaveLength(1);
  expect(['waitingApproval', 'waitingInput']).toContain(thread.status);
  expect(thread.turns.at(-1)?.items.some((item) => item.type === 'commandExecution')).toBe(false);
  return thread.actions.find((action) => action.status === 'pending')!;
}
async function fillForm(page: Page) {
  const card = page.locator('.action-card');
  await card.getByRole('textbox', { name: '项目名称', exact: true }).fill('截图项目');
  await card.getByRole('spinbutton', { name: '重试次数', exact: true }).fill('0');
  await card.getByRole('spinbutton', { name: '评分', exact: true }).fill('4.5');
  await chooseSelectOption(
    page,
    card.getByRole('combobox', { name: '启用通知', exact: true }),
    '否',
  );
  await chooseSelectOption(page, card.getByRole('combobox', { name: '环境', exact: true }), '预览');
  await card.getByLabel('网页', { exact: true }).check();
  await card.getByLabel('移动端', { exact: true }).check();
}

const viewports = [
  { name: 'desktop', width: 1280, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await mkdir(labelEvidence, { recursive: true });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  for (const thread of ((await response.json()) as ThreadPage).data) {
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

for (const [index, label] of ['允许本次', '本会话允许', '拒绝'].entries()) {
  test(`question confirmation preserves the selected answer: ${label}`, async ({ page }) => {
    await pendingTask(page, '[questions-choice] 确认下一步操作');
    const card = page.locator('.pending-actions .action-card');
    const submit = card.getByRole('button', { name: '确认选择', exact: true });
    await expect(submit).toBeDisabled();
    await card.getByRole('radio', { name: label, exact: false }).check();
    await expect(submit).toBeEnabled();
    await card.screenshot({ path: join(labelEvidence, `question-${index}.png`) });
    const submitted = page.waitForRequest(isResolution);
    await submit.click();
    expect((await submitted).postDataJSON().resolution).toEqual({
      answers: { confirmation: [label] },
    });
    await expect(card).not.toBeVisible();
    await expect(page.locator('.turn .action-card .async-question-answer')).toHaveText(label);
    await expect(page.locator('.turn .action-card input, .turn .action-card button')).toHaveCount(
      0,
    );
  });
}

test('other answers switch to answer submission and cannot submit while offline', async ({
  page,
  context,
}) => {
  await pendingTask(page, '[questions-choice] 选择之外也可以填写回答');
  const card = page.locator('.pending-actions .action-card');
  await card.getByRole('radio', { name: '其他回答', exact: true }).check();
  const submit = card.getByRole('button', { name: '提交回答', exact: true });
  await expect(submit).toBeDisabled();
  await card.getByRole('textbox', { name: '操作确认：自由回答' }).fill('请先解释允许的范围');
  await expect(submit).toBeEnabled();
  await card.screenshot({ path: join(labelEvidence, 'question-free-text.png') });
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await expect(submit).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await card.getByRole('radio', { name: '拒绝', exact: false }).check();
  await expect(card.getByRole('button', { name: '确认选择', exact: true })).toBeEnabled();
  await card.getByRole('radio', { name: '其他回答', exact: true }).check();
  const submitted = page.waitForRequest(isResolution);
  await submit.click();
  expect((await submitted).postDataJSON().resolution).toEqual({
    answers: { confirmation: ['请先解释允许的范围'] },
  });
  await expect(card).not.toBeVisible();
  await expect(page.locator('.turn .action-card .async-question-answer')).toHaveText(
    '请先解释允许的范围',
  );
  await expect(page.locator('.turn .action-card input, .turn .action-card button')).toHaveCount(0);
});

for (const allow of [true, false]) {
  test(`MCP boolean confirmation submits ${allow} as form content, not an approval decision`, async ({
    page,
  }) => {
    await pendingTask(page, '[elicitation-choice] 选择是否继续');
    const card = page.locator('.action-card');
    const submit = card.getByRole('button', { name: '确认选择', exact: true });
    await submit.click();
    await expect(card.getByRole('alert').last()).toBeVisible();
    await chooseSelectOption(
      page,
      card.getByRole('combobox', { name: '是否允许执行本次操作', exact: true }),
      allow ? '是' : '否',
    );
    await card.screenshot({ path: join(labelEvidence, `form-choice-${allow}.png`) });
    const submitted = page.waitForRequest(isResolution);
    await submit.click();
    expect((await submitted).postDataJSON().resolution).toEqual({
      decision: 'accept',
      content: { allow },
    });
    await expect(card).not.toBeVisible();
  });
}

test('an empty MCP form confirms continuation without pretending to submit answers', async ({
  page,
}) => {
  await pendingTask(page, '[elicitation-confirm] 确认继续操作');
  const card = page.locator('.action-card');
  await card.screenshot({ path: join(labelEvidence, 'form-confirm.png') });
  const submitted = page.waitForRequest(isResolution);
  await card.getByRole('button', { name: '确认继续', exact: true }).click();
  expect((await submitted).postDataJSON().resolution).toEqual({ decision: 'accept', content: {} });
  await expect(card).not.toBeVisible();
});

for (const [prompt, label, decision] of [
  ['[approval]', '允许本次', 'accept'],
  ['[file-approval]', '拒绝', 'decline'],
  ['[network]', '本会话允许', 'acceptForSession'],
] as const) {
  test(`direct approval retains its decision and scope: ${prompt}`, async ({ page }) => {
    await pendingTask(page, `${prompt} 检查审批操作与授权范围`);
    const card = page.locator('.action-card');
    for (const name of ['允许本次', '本会话允许', '拒绝', '取消当前任务'])
      await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '提交回答', exact: true })).toHaveCount(0);
    await card.screenshot({ path: join(labelEvidence, `direct-${decision}.png`) });
    const submitted = page.waitForRequest(isResolution);
    await card.getByRole('button', { name: label, exact: true }).click();
    expect((await submitted).postDataJSON().resolution).toEqual({ decision });
    await expect(card).not.toBeVisible();
  });
}

for (const viewport of viewports) {
  test(`${viewport.name} permissions stay pending across refresh and resume only after explicit approval`, async ({
    page,
    context,
  }) => {
    const outgoing: Request[] = [];
    page.on('request', (request) => {
      if (isResolution(request)) outgoing.push(request);
    });
    const threadId = await pendingTask(page, '[permissions] 上传本次截图附件');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const card = page.locator('.action-card');
    await expect(card.locator('.permission-details')).toContainText('report.txt');
    await expect(card.locator('.permission-details')).toContainText('screenshots');
    await assertWaiting(page, threadId);
    await page.reload();
    await expect(card).toBeVisible();
    await assertWaiting(page, threadId);
    await context.setOffline(true);
    await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
    for (const button of await card.getByRole('button').all()) await expect(button).toBeDisabled();
    await context.setOffline(false);
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    await assertWaiting(page, threadId);
    expect(outgoing).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const action = await assertWaiting(page, threadId);
    for (const option of action.options)
      await expect(card.getByRole('button', { name: option.label, exact: true })).toBeVisible();
    await page.screenshot({
      path: `${evidence}/permissions-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    if (viewport.name === 'mobile') {
      await card.getByRole('button', { name: '拒绝', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/permissions-mobile-actions.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    const decision = viewport.name === 'mobile' ? 'acceptForSession' : 'accept';
    await card
      .getByRole('button', {
        name: action.options.find((option) => option.id === decision)!.label,
        exact: true,
      })
      .click();
    await expect(card).not.toBeVisible();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.postDataJSON().resolution).toEqual({ decision });
  });

  test(`${viewport.name} MCP form validates missing data and submits typed values`, async ({
    page,
  }) => {
    const threadId = await pendingTask(page, '[elicitation-form] 确认截图发布设置');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const card = page.locator('.action-card');
    await expect(card).toContainText('截图发布服务');
    await card.getByRole('button', { name: '提交回答', exact: true }).click();
    await expect(card.getByRole('alert').last()).toBeVisible();
    await assertWaiting(page, threadId);
    await fillForm(page);
    const environment = card.getByRole('combobox', { name: '环境', exact: true });
    await chooseSelectOption(page, environment, '请选择');
    await expect(environment).toHaveAttribute('aria-invalid', 'true');
    await environment.click();
    await page.screenshot({
      path: `${evidence}/select-form-${viewport.name}-menu.png`,
      fullPage: true,
    });
    await page.getByRole('option', { name: '预览', exact: true }).click();
    await expect(environment).toHaveAttribute('aria-invalid', 'false');
    await card.getByRole('textbox', { name: '项目名称', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/elicitation-form-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.getByRole('button', { name: '提交回答', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/elicitation-form-${viewport.name}-actions.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const submitted = page.waitForRequest(isResolution);
    await card.getByRole('button', { name: '提交回答', exact: true }).click();
    expect((await submitted).postDataJSON().resolution).toEqual({
      decision: 'accept',
      content: {
        project: '截图项目',
        retries: 0,
        rating: 4.5,
        notify: false,
        environment: 'preview',
        channels: ['web', 'mobile'],
      },
    });
    await expect(card).not.toBeVisible();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  });

  test(`${viewport.name} opening an MCP authorization URL does not implicitly approve it`, async ({
    page,
    context,
  }) => {
    await context.route('https://example.com/authorize?*', (route) =>
      route.fulfill({ body: '<p>Fixture authorization page</p>', contentType: 'text/html' }),
    );
    const threadId = await pendingTask(page, '[elicitation-url] 在浏览器中授权截图服务');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const card = page.locator('.action-card');
    const link = card.getByRole('link', { name: '在新标签页打开', exact: true });
    await expect(link).toHaveAttribute('href', 'https://example.com/authorize?service=screenshots');
    const popupReady = page.waitForEvent('popup');
    await link.click();
    const popup = await popupReady;
    await expect(popup.getByText('Fixture authorization page')).toBeVisible();
    await popup.close();
    await assertWaiting(page, threadId);
    await page.screenshot({
      path: `${evidence}/elicitation-url-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const submitted = page.waitForRequest(isResolution);
    await card.getByRole('button', { name: '我已完成', exact: true }).click();
    expect((await submitted).postDataJSON().resolution).toEqual({ decision: 'accept' });
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  });
}

for (const decision of ['decline', 'cancel'] as const) {
  test(`MCP ${decision} closes the pending form without executing the fixture command`, async ({
    page,
  }) => {
    const threadId = await pendingTask(page, '[elicitation-form] 可以拒绝或取消');
    const submitted = page.waitForRequest(isResolution);
    await page
      .locator('.action-card')
      .getByRole('button', { name: decision === 'decline' ? '拒绝' : '取消', exact: true })
      .click();
    expect((await submitted).postDataJSON().resolution).toEqual({ decision });
    await expect(page.locator('.action-card')).not.toBeVisible();
    const response = await page.request.get(`/api/threads/${threadId}`);
    const thread = (await response.json()) as ThreadView;
    expect(thread.turns.at(-1)?.status).toBe('interrupted');
    expect(thread.turns.at(-1)?.items.some((item) => item.type === 'commandExecution')).toBe(false);
  });
}

test('an unsupported form remains visible for an explicit decline and never silently rejects', async ({
  page,
}) => {
  const threadId = await pendingTask(page, '[elicitation-malformed] 不支持的表单仍然需要用户决定');
  const card = page.locator('.action-card');
  await expect(card.getByRole('alert').last()).toBeVisible();
  await expect(card.getByRole('button', { name: '提交回答', exact: true })).toHaveCount(0);
  await assertWaiting(page, threadId);
  await page.screenshot({
    path: `${evidence}/elicitation-unsupported.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(card).not.toBeVisible();
});

test('tampered permission responses fail without consuming the pending action and can still be declined', async ({
  page,
}) => {
  const threadId = await pendingTask(page, '[permissions] 验证拒绝与权限边界');
  const action = await assertWaiting(page, threadId);
  const invalid = await page.request.post(
    `/api/actions/${encodeURIComponent(action.actionId)}/resolve`,
    {
      headers,
      data: {
        clientOperationId: randomUUID(),
        resolution: {
          decision: 'accept',
          permissions: { network: { enabled: true }, fileSystem: { write: ['/'] } },
        },
      },
    },
  );
  expect(invalid.status()).toBe(400);
  await assertWaiting(page, threadId);
  await page.locator('.action-card').getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.action-card')).not.toBeVisible();
  const response = await page.request.get(`/api/threads/${threadId}`);
  const thread = (await response.json()) as ThreadView;
  expect(thread.turns.at(-1)?.status).toBe('interrupted');
  expect(thread.turns.at(-1)?.items.some((item) => item.type === 'commandExecution')).toBe(false);
});

test('unknown interactive RPC failures stay visible without approval controls', async ({
  page,
}) => {
  const threadId = await pendingTask(page, '[unsupported] 显示不支持的交互请求');
  const card = page.locator('.action-card-unsupported');
  await expect(card).toContainText('请求未能处理');
  await expect(card.getByRole('button')).toHaveCount(0);
  const thread = (await (await page.request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  expect(thread.actions).toEqual([
    expect.objectContaining({ kind: 'unsupported', status: 'expired' }),
  ]);
  expect(thread.turns.at(-1)?.status).toBe('interrupted');
  await page.reload();
  await expect(card).toContainText('请求未能处理');
});

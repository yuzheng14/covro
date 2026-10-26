import { expect, test, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ThreadPage, ThreadView } from '../../src/shared/types';
import {
  compatibilityDialog,
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  testOrigin,
  expectThreadReady,
} from './helpers';

const headers = { Origin: testOrigin };
const taskInput = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const sendButton = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const sendTooltip = (page: Page) =>
  page.getByRole('tooltip').filter({ hasText: 'Enter 发送 / Shift + Enter 换行' });
const isSubmission = (request: Request) =>
  request.method() === 'POST' && /\/api\/threads\/[^/]+\/(turns|steer)$/.test(request.url());
function submissions(page: Page) {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (isSubmission(request)) requests.push(request);
  });
  return requests;
}
async function newThread(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createEmptyThread(page);
  await expectThreadReady(page);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function flushKeyboardEvents(page: Page) {
  // Let any request caused by the keyboard event leave the browser before checking absence.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        }),
      ),
  );
}

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

test('Enter submits a task and steers the same active thread and turn', async ({
  page,
  request,
}) => {
  const threadId = await newThread(page);
  const input = taskInput(page);
  const task = '[approval] 检查当前工作区';
  await input.fill(task);
  const started = page.waitForRequest(isSubmission);
  await input.press('Enter');
  const startRequest = await started;
  expect(new URL(startRequest.url()).pathname).toBe(`/api/threads/${threadId}/turns`);
  expect(startRequest.postDataJSON().text).toBe(task);
  await expect(page.locator('.action-card')).toBeVisible();
  const current = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  const turnId = current.turns.at(-1)!.id;
  const steer = page.getByRole('textbox', { name: '追加要求', exact: true });
  await expect(steer).toHaveValue('');
  const additional = '    保留这段缩进\n第二行也需要保留\n';
  await steer.fill(additional);
  const steerButton = page.getByRole('button', { name: '追加要求', exact: true });
  await expect(steerButton).toHaveAccessibleDescription('Enter 发送 / Shift + Enter 换行');
  await steerButton.hover();
  await expect(sendTooltip(page)).toHaveText('Enter 发送 / Shift + Enter 换行');
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(sendTooltip(page)).toHaveCount(0);
  const steered = page.waitForRequest(isSubmission);
  await steer.press('Enter');
  const steerRequest = await steered;
  expect(new URL(steerRequest.url()).pathname).toBe(`/api/threads/${threadId}/steer`);
  expect(steerRequest.postDataJSON()).toMatchObject({ text: additional, expectedTurnId: turnId });
  await expect(steer).toHaveValue('');
  await expect(page.locator('.user-text').nth(1)).toHaveJSProperty('textContent', additional);
  await expect(page.locator('.turn')).toHaveCount(1);
});

test('Shift+Enter and native multiline paste preserve the exact draft until Enter sends', async ({
  page,
  context,
}) => {
  await newThread(page);
  const outgoing = submissions(page);
  const input = taskInput(page);
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('第一行\n\n');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const pasted = '    const message = "你好";\n\treturn message;\n';
  await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
  await input.press('ControlOrMeta+V');
  const draft = `第一行\n\n${pasted}`;
  await expect(input).toHaveValue(draft);
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await input.press('Enter');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(outgoing).toHaveLength(1);
  expect(outgoing[0]!.postDataJSON().text).toBe(draft);
  await expect(page.locator('.user-text')).toHaveJSProperty('textContent', draft);
});

test('IME candidate confirmation and composition-end-adjacent Enter never submit a draft', async ({
  page,
}) => {
  await newThread(page);
  const outgoing = submissions(page);
  const input = taskInput(page);
  const draft = '中文候选词确认后仍留在输入框';
  await input.fill(draft);
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await input.dispatchEvent('compositionstart');
  // Some engines report isComposing=false while the composition lifecycle is still active.
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false });
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
    );
  });
  await expect(input).toHaveValue(draft);
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await expect(page.locator('.turn')).toHaveCount(0);
  // Keep release and the next keydown in one browser task: the IME grace window must
  // not swallow a deliberate new Enter after the confirmation key has been released.
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    element.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(outgoing).toHaveLength(1);
  expect(outgoing[0]!.postDataJSON().text).toBe(draft);
});

test('Enter honors unavailable-project, blank-draft, offline, compatibility and runtime guards', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const outgoing = submissions(page);
  const input = taskInput(page);
  await page
    .getByRole('region', { name: '不可用项目', exact: true })
    .getByRole('button', { name: '不可用项目', exact: true })
    .click();
  await input.fill('项目不可用');
  await expect(sendButton(page)).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await createEmptyThread(page);
  await expectThreadReady(page);
  // Exclude the fixture-only setup send from guarded user submissions.
  outgoing.length = 0;
  await input.fill('  \n\t');
  await expect(sendButton(page)).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  const draft = '暂时不能发送的草稿';
  await input.fill(draft);
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await expect(sendButton(page)).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await controlRuntime(request, { version: 'fixture-composer-unconfirmed' });
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(sendButton(page)).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await page.getByRole('button', { name: '查看兼容性提示', exact: true }).click();
  await confirmCompatibility(page);
  await controlRuntime(request, { unavailable: true });
  await expect(sendButton(page)).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await expect(input).toHaveValue(draft);
});

test('an uncertain submission keeps its draft and blocks another Enter request', async ({
  page,
}) => {
  await newThread(page);
  let attempts = 0;
  await page.route('**/api/threads/*/turns', async (route) => {
    attempts++;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'RESULT_UNKNOWN', message: '提交结果尚未确认' } },
    });
  });
  await taskInput(page).fill('等待确认的任务');
  await taskInput(page).press('Enter');
  await expect(page.locator('.pending-notice')).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await taskInput(page).press('Enter');
  await flushKeyboardEvents(page);
  expect(attempts).toBe(1);
  await expect(taskInput(page)).toHaveValue('等待确认的任务');
});

test('repeated and duplicate Enter events dispatch once, and a failed send keeps the draft', async ({
  page,
}) => {
  await newThread(page);
  const outgoing = submissions(page);
  const input = taskInput(page);
  const draft = '失败后保留，并且只发送一次';
  await input.fill(draft);
  // A menu can consume Enter before React's delegated keyboard handler receives it.
  await input.evaluate((element) => {
    element.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  });
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await expect(input).toHaveValue(draft);
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await expect(input).toHaveValue(draft);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/turns', async (route) => {
    await delayed;
    await route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_RPC_ERROR', message: '测试发送失败' } },
    });
  });
  await input.evaluate((element) => {
    for (const repeat of [false, false, true])
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          repeat,
        }),
      );
  });
  await expect(page.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled();
  await input.press('Enter');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(1);
  release();
  await expect(page.locator('.error-banner.dismissible')).toContainText('测试发送失败');
  await expect(input).toHaveValue(draft);
  await expect(sendButton(page)).toBeEnabled();
  await page.unroute('**/api/threads/*/turns');
  await input.press('Enter');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(outgoing).toHaveLength(2);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} composer keeps shortcut guidance in a tooltip and its send button works`, async ({
    page,
  }) => {
    await newThread(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (viewport.name === 'mobile') await expect(page.locator('.sidebar')).not.toBeInViewport();
    const tooltip = sendTooltip(page);
    await expect(tooltip).toHaveCount(0);
    await taskInput(page).fill('点击发送按钮提交任务\n也可以使用 Shift + Enter 换行');
    await expect(sendButton(page)).toBeVisible();
    await expect(sendButton(page)).toHaveAccessibleDescription('Enter 发送 / Shift + Enter 换行');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/issue-26-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    if (viewport.name === 'desktop') {
      await sendButton(page).hover();
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveText('Enter 发送 / Shift + Enter 换行');
      await page
        .locator('.composer-box')
        .screenshot({ path: '/tmp/codex-shadcn-send-tooltip.png' });
      await page.screenshot({
        path: '/tmp/issue-26-tooltip.png',
        fullPage: true,
        animations: 'disabled',
      });
      // Hover does not move focus from the editor, so Escape must also dismiss
      // the hint when its keyboard event originates outside the button wrapper.
      await expect(taskInput(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(tooltip).toHaveCount(0);
      await expect(taskInput(page)).toBeFocused();
      await page.mouse.move(0, 0, { steps: 5 });
      await sendButton(page).hover();
      await expect(tooltip).toBeVisible();
      await page.mouse.move(0, 0, { steps: 5 });
      await expect(tooltip).toHaveCount(0);
      await taskInput(page).focus();
      await taskInput(page).press('Tab');
      const attach = page.getByRole('button', { name: '添加图片', exact: true });
      await expect(attach).toBeFocused();
      await attach.press('Tab');
      const policy = page.getByRole('combobox', { name: '权限模式', exact: true });
      await expect(policy).toBeFocused();
      await policy.press('Tab');
      const details = page.getByRole('button', { name: '权限详情', exact: true });
      await expect(details).toBeFocused();
      await details.press('Tab');
      const modelSettings = page.getByRole('button', { name: '模型设置', exact: true });
      await expect(modelSettings).toBeFocused();
      await modelSettings.press('Tab');
      await expect(sendButton(page)).toBeFocused();
      await expect(tooltip).toBeVisible();
      await sendButton(page).press('Escape');
      await expect(tooltip).toHaveCount(0);
      await expect(sendButton(page)).toBeFocused();
      await sendButton(page).press('Shift+Tab');
      await expect(modelSettings).toBeFocused();
      await modelSettings.press('Tab');
      await expect(tooltip).toBeVisible();
      await sendButton(page).press('Shift+Tab');
      await expect(modelSettings).toBeFocused();
      await expect(tooltip).toHaveCount(0);
    }
    await sendButton(page).click();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(taskInput(page)).toHaveValue('');
  });
}

import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';
import {
  asyncQuestionId,
  encodeQuestionReplies,
  parseQuestionReplies,
} from '../../src/shared/async-questions';
import type { ThreadView } from '../../src/shared/types';

const questionIndicator = (page: Page) =>
  page.locator('.thread-row:has(.thread-selected) .thread-status-waitingInput');
const card = (page: Page) => page.getByRole('region', { name: 'Codex 的提问' });
const freeName = (page: Page) =>
  card(page).getByRole('textbox', { name: '项目名称是什么？：自由回答' });
const send = async (page: Page, prompt: string) => {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(card(page).first()).toBeVisible();
};

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
});

test('async questions survive reload and send native answers after the turn ends', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 1050 });
  await send(page, '[async-questions] 帮我确认项目偏好');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
  await expect(page.locator('.topbar-status > .status-waitingInput')).toBeVisible();
  await expect(card(page).getByRole('radio', { name: '深色（推荐）', exact: true })).toBeChecked();
  await expect(card(page).getByRole('button', { name: '发送回答', exact: true })).toBeDisabled();
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.pending-actions')).toHaveCount(0);
  await expect(questionIndicator(page)).toBeVisible();
  // The form has its own draft; replying must preserve the ordinary composer draft.
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('稍后要发送的另一条要求');
  await freeName(page).fill('我的项目');
  await context.setOffline(true);
  await expect(card(page).getByRole('button', { name: '发送回答', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(card(page).getByRole('button', { name: '发送回答', exact: true })).toBeEnabled();
  await expect(freeName(page)).toHaveValue('我的项目');
  await questionIndicator(page).hover();
  await expect(page.getByRole('tooltip', { name: '等待回答 · 1 项待处理' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('questions-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const bounds = await page.locator('.sidebar').boundingBox();
      return bounds ? bounds.x + bounds.width : 0;
    })
    .toBeLessThanOrEqual(1);
  await card(page).evaluate((element) =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('questions-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await expect(questionIndicator(page)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('questions-mobile-sidebar.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/api\/threads\/[^/]+\/turns$/.test(r.url()),
  );
  await card(page).getByRole('button', { name: '发送回答', exact: true }).click();
  const replies = parseQuestionReplies((await request).postDataJSON().text)!;
  expect(replies.map(({ question, answer }) => ({ question, answer }))).toEqual([
    { question: '界面使用哪种主题？', answer: '深色（推荐）' },
    { question: '项目名称是什么？', answer: '我的项目' },
  ]);
  await expect(card(page)).toContainText('已发送回答');
  await expect(questionIndicator(page)).toHaveCount(0);
  await expect(page.locator('.topbar-status > .status-waitingInput')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '追加要求', exact: true })).toHaveValue(
    '稍后要发送的另一条要求',
  );
  const reply = page.locator('.user-message').last();
  await expect(reply.locator('blockquote')).toHaveText(['界面使用哪种主题？', '项目名称是什么？']);
  await expect(reply.locator('.user-text')).toHaveText(['深色（推荐）', '我的项目']);
  await page.reload();
  await expect(card(page)).toContainText('已发送回答');
  await expect(card(page).getByRole('button', { name: '发送回答', exact: true })).toHaveCount(0);
  await expect(card(page)).toContainText('我的项目');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(reply.locator('blockquote')).toHaveText(['界面使用哪种主题？', '项目名称是什么？']);
  await reply.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('answered-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1360, height: 1050 });
  await card(page).evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.screenshot({
    path: testInfo.outputPath('answered-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('running async questions use steer and allow a custom answer to an option question', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 1050 });
  await send(page, '[async-questions-running] 执行时确认偏好');
  await expect(page.locator('.turn-heading .status')).toHaveText('执行中');
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
  await expect(
    page.locator('.thread-row:has(.thread-selected) .thread-status-running'),
  ).toBeVisible();
  await questionIndicator(page).hover();
  await expect(page.getByRole('tooltip', { name: '等待回答 · 1 项待处理' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('questions-running.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const originalId = await page.locator('.thread-selected').getAttribute('data-thread-id');
  await createEmptyThread(page);
  const originalLink = page.locator(`[data-thread-id="${originalId}"]`);
  await expect(originalLink).toContainText('等待回答 · 1 项待处理');
  await originalLink.click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.topbar-status > .status-waitingInput')).toBeVisible();
  await card(page).getByRole('radio', { name: '自由回答', exact: true }).check();
  await card(page)
    .getByRole('textbox', { name: '界面使用哪种主题？：自由回答' })
    .fill('跟随系统\n允许手动切换');
  await freeName(page).fill('测试项目');
  const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/steer'));
  await card(page).getByRole('button', { name: '发送回答', exact: true }).click();
  expect(parseQuestionReplies((await request).postDataJSON().text)![0]!.answer).toBe(
    '跟随系统\n允许手动切换',
  );
  await expect(card(page)).toContainText('已发送回答');
  await expect(page.locator('.turn')).toHaveCount(1);
  await page.reload();
  await expect(card(page)).toContainText('已发送回答');
  const reply = page.locator('.user-message').last();
  await expect(reply.locator('blockquote')).toHaveText(['界面使用哪种主题？', '项目名称是什么？']);
  await expect(reply.locator('.user-text').first()).toHaveJSProperty(
    'textContent',
    '跟随系统\n允许手动切换',
  );
});

test('a definite send failure retains answers and a lost receipt does not replay the answer', async ({
  page,
}) => {
  await send(page, '[async-questions] 确认后继续');
  await freeName(page).fill('保留这份回答');
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'THREAD_BUSY', message: '测试：任务状态刚发生变化' } }),
    }),
  );
  await card(page).getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(freeName(page)).toHaveValue('保留这份回答');
  await expect(card(page).getByRole('button', { name: '发送回答', exact: true })).toBeEnabled();
  await page.unroute('**/api/threads/*/turns');
  let submissions = 0;
  await page.route('**/api/threads/*/turns', async (route) => {
    submissions++;
    await route.fetch();
    await route.abort('failed');
  });
  await card(page).getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(card(page)).toContainText('已发送回答');
  expect(submissions).toBe(1);
  await page.reload();
  await expect(card(page)).toContainText('已发送回答');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const response = await page.request.get(`${testOrigin}/api/threads/${id}`);
  const thread = (await response.json()) as ThreadView;
  expect(
    thread.turns.flatMap((turn) => turn.items).filter((item) => item.questionReplies?.length),
  ).toHaveLength(1);
});

test('native answers from another client resolve only their individual question', async ({
  page,
}) => {
  await send(page, '[async-questions] 从 CLI 继续到网页');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
  const source = thread.turns.flatMap((turn) => turn.items).find((item) => item.questions?.length)!;
  const response = await page.request.post(`/api/threads/${id}/turns`, {
    headers: { Origin: testOrigin },
    data: {
      clientOperationId: randomUUID(),
      text: encodeQuestionReplies([
        {
          questionItemId: asyncQuestionId(source.id, 0),
          question: '界面使用哪种主题？\n请选择 **深色** 或 <浅色>。',
          answer: '来自 CLI 的浅色选择',
        },
      ]),
    },
  });
  expect(response.ok()).toBe(true);
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.reload();
  await expect(card(page)).toContainText('来自 CLI 的浅色选择');
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
  const reply = page.locator('.user-message').last();
  await expect(reply.locator('blockquote')).toHaveJSProperty(
    'textContent',
    '界面使用哪种主题？\n请选择 **深色** 或 <浅色>。',
  );
  await expect(reply.locator('blockquote strong')).toHaveCount(0);
  await expect(reply.locator('.user-text')).toHaveText('来自 CLI 的浅色选择');
  await expect(card(page).getByRole('radio')).toHaveCount(0);
  await expect(freeName(page)).toBeVisible();
  await freeName(page).fill('网页补充的项目名');
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/api\/threads\/[^/]+\/turns$/.test(r.url()),
  );
  await card(page).getByRole('button', { name: '发送回答', exact: true }).click();
  expect(parseQuestionReplies((await request).postDataJSON().text)).toEqual([
    {
      questionItemId: asyncQuestionId(source.id, 1),
      question: '项目名称是什么？',
      answer: '网页补充的项目名',
    },
  ]);
  await page.reload();
  await expect(card(page)).toContainText('已发送回答');
  await expect(card(page)).toContainText('来自 CLI 的浅色选择');
  await expect(card(page)).toContainText('网页补充的项目名');
});

test('answering one question group leaves another group available and ordinary messages do not resolve it', async ({
  page,
}) => {
  await send(page, '[async-questions-multiple] 多组问题');
  await expect(card(page)).toHaveCount(2);
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 2 项待处理');
  await freeName(page).fill('分组项目');
  await card(page).first().getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(card(page).first()).toContainText('已发送回答');
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
  await expect(card(page).last().getByRole('textbox')).toBeVisible();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await send(page, '先继续其他工作，这不是问题的回答');
  await expect(card(page).last()).not.toContainText('已发送回答');
  await page.reload();
  await expect(card(page).first()).toContainText('已发送回答');
  await expect(card(page).last()).not.toContainText('已发送回答');
  await expect(questionIndicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
});

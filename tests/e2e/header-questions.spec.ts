import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createEmptyThread } from './helpers';
import type { ThreadView } from '../../src/shared/types';

const entry = (page: Page) => page.locator('.topbar button.status-waitingInput');
const dialog = (page: Page) => page.locator('.pending-questions-dialog[open]');
const cards = (page: Page) => page.locator('.async-question-card');
const sidebarWaiting = (page: Page) =>
  page.locator('.thread-row:has(.thread-selected) .thread-status-waitingInput');

async function send(page: Page, text: string, status = '已完成') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText(status);
}

test('paged questions jump to the exact old card and skip only the chosen question', async ({
  page,
  request,
  context,
}, info) => {
  test.setTimeout(85_000);
  await controlRuntime(request, {
    reset: true,
    fixtureOptions: { paginated: true, historyPageSize: 2 },
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[async-questions-multiple] Review settings');
  const oldTurn = await page.locator('.turn').first().getAttribute('data-turn-id');
  for (const text of ['Intervening work A', 'Intervening work B', 'Latest work'])
    await send(page, text);
  const id = await page.locator('.thread-selected').getAttribute('data-thread-id');
  await controlRuntime(request, { restart: true });
  await page.reload();
  await confirmCompatibility(page);
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(cards(page)).toHaveCount(0);
  await expect(entry(page)).toBeVisible();
  await expect(sidebarWaiting(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 880 });
  await entry(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  await expect(dialog(page).locator('li').first()).toContainText('第 1 轮');
  await page.screenshot({ path: info.outputPath('desktop-zh-list.png') });
  await page.keyboard.press('Escape');
  await expect(entry(page)).toBeFocused();
  await page.evaluate(() => localStorage.setItem('covro.locale', 'en'));
  await page.reload();
  await expect(entry(page)).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await entry(page).click();
  await expect(dialog(page).getByRole('heading', { name: 'Pending questions' })).toBeVisible();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('mobile-en-list.png') });
  await dialog(page)
    .getByRole('button', { name: /项目名称是什么/ })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.locator('.async-question-title', { hasText: '项目名称是什么？' }),
  ).toBeFocused();
  await expect(page.locator(`[data-turn-id="${oldTurn}"]`)).toHaveCount(1);
  await expect(page.locator('.turn')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('mobile-en-location.png') });
  await page.setViewportSize({ width: 1280, height: 880 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .locator('.async-question-title', { hasText: '项目名称是什么？' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('desktop-en-location.png') });
  const locationTraffic: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/history?')) locationTraffic.push(r.url());
  });
  const second = await context.newPage();
  await second.goto('/');
  await expect(entry(second)).toBeVisible();
  await entry(second).click();
  await expect(dialog(second).locator('li')).toHaveCount(3);
  await entry(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  const row = dialog(page).locator('li').filter({ hasText: '项目名称是什么？' });
  const dismiss = page.waitForRequest((r) => r.url().endsWith('/questions/dismiss'));
  await row
    .getByRole('button', { name: 'Skip', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  const submitted = await dismiss;
  expect(submitted.postDataJSON().questionIds).toHaveLength(1);
  await expect(dialog(page).locator('li')).toHaveCount(2);
  await expect(dialog(second).locator('li')).toHaveCount(2);
  await expect(sidebarWaiting(page)).toBeVisible();
  await page.keyboard.press('Escape');
  const first = cards(page).filter({ hasText: '界面使用哪种主题？' });
  await expect(first).toContainText('Skipped · no answer sent');
  await first.getByRole('button', { name: 'Send answer' }).click();
  await expect(first).toContainText('深色（推荐）');
  await entry(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(1);
  await dialog(page).getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(dialog(page).getByText('No pending questions')).toBeVisible();
  await expect(dialog(second).getByText('No pending questions')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.topbar')).toBeFocused();
  await expect(entry(page)).toHaveCount(0);
  await expect(sidebarWaiting(page)).toHaveCount(0);
  expect(locationTraffic).toHaveLength(0);
  const after = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(after.pendingQuestions?.count).toBe(0);
  await expect(first).toContainText('Skipped · no answer sent');
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('desktop-en-handled.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mobile-en-handled.png') });
  await controlRuntime(request, { restart: true });
  await page.reload();
  // Interface preference travels with this browser and the new gateway requires confirmation.
  const confirmation = page.locator('.compatibility-dialog[open]');
  await expect(confirmation).toBeVisible();
  await confirmation.locator('button').last().click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/threads/${id}/questions`);
      return (await response.json()).history;
    })
    .toBe('ready');
  await expect(entry(page)).toHaveCount(0);
  await expect(sidebarWaiting(page)).toHaveCount(0);
});

test('native questions navigate to the live form and use its native skip', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[questions] Settings for the current task', '等待回答');
  await entry(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(2);
  await expect(dialog(page).getByRole('button', { name: '跳过', exact: true })).toHaveCount(0);
  await dialog(page).locator('.pending-question-link').first().click();
  await expect(page.locator('.pending-actions .action-card legend').first()).toBeFocused();
  await page
    .locator('.pending-actions .action-card')
    .getByRole('button', { name: '全部跳过并提交' })
    .click();
  await expect(entry(page)).toHaveCount(0);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('questions from two turns coexist with execution at narrow widths in Japanese and Korean', async ({
  page,
  request,
}, info) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[async-questions] Earlier settings');
  await send(page, '[async-questions-running] Current settings', '运行中');
  for (const [locale, title, colorScheme] of [
    ['ja', '未回答の質問', 'light'],
    ['ko', '답변 대기 질문', 'dark'],
  ] as const) {
    await page.evaluate((locale) => localStorage.setItem('covro.locale', locale), locale);
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await entry(page).click();
    await expect(dialog(page).getByRole('heading', { name: title })).toBeVisible();
    await expect(dialog(page).locator('li')).toHaveCount(4);
    const turns = await dialog(page).locator('.pending-question-turn').allTextContents();
    expect(new Set(turns).size).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: info.outputPath(`mobile-${locale}-list.png`) });
    await page.keyboard.press('Escape');
    await expect(entry(page)).toBeFocused();
  }
});

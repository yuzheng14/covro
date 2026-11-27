import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createEmptyThread } from './helpers';
import type { PendingQuestionsPage } from '../../src/shared/pending-questions';
import type { DismissQuestionsInput, ThreadView } from '../../src/shared/types';

const entry = (page: Page) => page.locator('.topbar button.status-waitingInput:visible');
const dialog = (page: Page) => page.locator('.pending-questions-dialog[open]');
const cards = (page: Page) => page.locator('.async-question-card');
const sidebarWaiting = (page: Page) =>
  page.locator('.thread-row:has(.thread-selected) .thread-status-waitingInput');
const moreActions = (page: Page) => page.locator('.topbar-more');
const findQuestions = (page: Page) =>
  page.getByRole('button', { name: /^(查看待回答问题|Check pending questions)$/ });

async function send(page: Page, text: string, status = '已完成') {
  const turns = page.locator('.conversation-content .turn');
  const before = await turns.count();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(turns).toHaveCount(before + 1);
  await expect(turns.last().locator('.turn-heading .status')).toHaveText(status);
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
  const discovery: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(`/threads/${id}/questions`))
      discovery.push(request.url());
  });
  await controlRuntime(request, { restart: true });
  await page.reload();
  await confirmCompatibility(page);
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(cards(page)).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 880 });
  await expect(entry(page)).toHaveCount(0);
  await expect(sidebarWaiting(page)).toHaveCount(0);
  await moreActions(page).click();
  await expect(findQuestions(page)).toBeVisible();
  expect(discovery).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('desktop-zh-more-actions.png') });
  await findQuestions(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  expect(discovery.length).toBeGreaterThan(0);
  await expect(dialog(page).locator('li').first()).toContainText('第 1 轮');
  await page.screenshot({ path: info.outputPath('desktop-zh-list.png') });
  await page.keyboard.press('Escape');
  await expect(moreActions(page)).toBeFocused();
  await expect(entry(page)).toHaveCount(0);
  await expect(sidebarWaiting(page)).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('covro.locale', 'en'));
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(2);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.topbar')).toHaveAttribute('data-compact', 'true');
  await moreActions(page).click();
  await expect(findQuestions(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-en-more-actions.png') });
  await findQuestions(page).click();
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
  await second.setViewportSize({ width: 1440, height: 900 });
  const secondDiscovery: string[] = [];
  second.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(`/threads/${id}/questions`))
      secondDiscovery.push(request.url());
  });
  await second.goto('/');
  await expect(second.locator('.turn')).toHaveCount(2);
  await expect(entry(second)).toHaveCount(0);
  await second.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(cards(second)).not.toHaveCount(0);
  await expect(entry(second)).toBeVisible();
  await expect(sidebarWaiting(second)).toBeVisible();
  expect(secondDiscovery).toHaveLength(0);
  await cards(second).first().scrollIntoViewIfNeeded();
  await second.screenshot({ path: info.outputPath('desktop-en-after-pagination.png') });
  await entry(second).click();
  await expect(dialog(second).locator('li')).toHaveCount(3);
  await entry(page).click();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  const row = dialog(page).locator('li').filter({ hasText: '项目名称是什么？' });
  const skip = row.getByRole('button', { name: 'Skip', exact: true });
  await expect(skip).toBeEnabled();
  const dismiss = page.waitForRequest((r) => r.url().endsWith('/questions/dismiss'));
  await skip.evaluate((button: HTMLButtonElement) => {
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
  await send(page, '[async-questions-running] Current settings', '执行中');
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

test('closing the list and switching sessions releases an in-flight location', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, 'Second session');
  const destination = await page.locator('.thread-selected').getAttribute('data-thread-id');
  await createEmptyThread(page);
  await send(page, '[async-questions] Locate while changing sessions');
  let release!: () => void;
  const deferredLocation = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const locationRequested = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/questions/location?*', async (route) => {
    const response = await route.fetch();
    received();
    await deferredLocation;
    await route.fulfill({ response }).catch(() => {
      // Closing the dialog may already have canceled the browser request.
    });
  });
  await entry(page).click();
  await dialog(page).locator('.pending-question-link').first().click();
  await locationRequested;
  await page.keyboard.press('Escape');
  await page.locator(`.thread-link[data-thread-id="${destination}"]`).click();
  await expect(page.locator('.thread-selected')).toHaveAttribute('data-thread-id', destination!);
  release();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(0);
  await expect(entry(page)).toHaveCount(0);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('consecutive skips update immediately and only the failed question returns', async ({
  page,
  request,
}, info) => {
  await controlRuntime(request, { reset: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, '[async-questions-multiple] Review settings');
  await page.evaluate(() => localStorage.setItem('covro.locale', 'en'));
  await page.reload();
  await expect(cards(page)).not.toHaveCount(0);
  const threadId = await page.locator('.thread-selected').getAttribute('data-thread-id');
  await entry(page).click();
  const rows = dialog(page).locator('li');
  const skip = () => dialog(page).getByRole('button', { name: 'Skip', exact: true });
  await expect(rows).toHaveCount(3);
  const summaries = await rows.locator('.pending-question-summary').allTextContents();
  const firstGate = gate();
  const thirdGate = gate();
  const events: string[] = [];
  const submissions: DismissQuestionsInput[] = [];
  await page.route('**/questions/dismiss', async (route) => {
    submissions.push(route.request().postDataJSON());
    const index = submissions.length;
    events.push(`POST ${index}`);
    if (index === 1) await firstGate.promise;
    if (index === 3) await thirdGate.promise;
    if (index === 2) {
      events.push('409 2');
      await route.fulfill({
        status: 409,
        json: { error: { code: 'QUESTION_BUSY', message: 'Fixture rejection' } },
      });
    } else {
      const response = await route.fetch();
      events.push(`${response.status()} ${index}`);
      await route.fulfill({ response });
    }
  });
  try {
    await skip()
      .first()
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect.poll(() => submissions.length).toBe(1);
    await page.screenshot({ path: info.outputPath('first-request-held.png') });
    await expect(skip().last()).toBeEnabled({ timeout: 2500 });
    await expect(rows).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('desktop-en-first-request-held.png') });
    await skip().first().click();
    await expect(rows).toHaveCount(1);
    await skip().first().click();
    await expect(rows).toHaveCount(0);
    await expect(entry(page)).toHaveCount(0);
    await expect(sidebarWaiting(page)).toHaveCount(0);
    await expect(dialog(page).getByText('Skipping questions…')).toBeVisible();
    expect(submissions).toHaveLength(1);
    events.push('All rows hidden while POST 1 was held');
    await page.screenshot({ path: info.outputPath('desktop-en-skips-in-progress.png') });
    firstGate.release();
    await expect.poll(() => submissions.length).toBe(3);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(summaries[1]!);
    await expect(rows.getByRole('alert')).toHaveText('Could not skip. Try again.');
    await expect(skip()).toBeEnabled();
    await expect(entry(page)).toBeVisible();
    await expect(sidebarWaiting(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath('desktop-en-failed-row-restored.png') });
    await skip().click();
    await expect(rows).toHaveCount(0);
    expect(submissions).toHaveLength(3);
    thirdGate.release();
    await expect(dialog(page).getByText('No pending questions')).toBeVisible();
    expect(events).toEqual([
      'POST 1',
      'All rows hidden while POST 1 was held',
      '200 1',
      'POST 2',
      '409 2',
      'POST 3',
      '200 3',
      'POST 4',
      '200 4',
    ]);
    expect(submissions.map(({ questionIds }) => questionIds)).toEqual([
      submissions[0]!.questionIds,
      submissions[1]!.questionIds,
      submissions[2]!.questionIds,
      submissions[1]!.questionIds,
    ]);
    expect(new Set(submissions.map(({ clientOperationId }) => clientOperationId)).size).toBe(4);
    expect(new Set(submissions.slice(0, 3).flatMap(({ questionIds }) => questionIds)).size).toBe(3);
    const view = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
    expect(view.turns).toHaveLength(1);
    expect(view.pendingQuestions?.count).toBe(0);
    expect(Object.values(view.questionTracking ?? {}).map(({ status }) => status)).toEqual([
      'dismissed',
      'dismissed',
      'dismissed',
    ]);
    await page.screenshot({ path: info.outputPath('desktop-en-skips-complete.png') });
    await page.keyboard.press('Escape');
    await expect(cards(page).getByText('Skipped · no answer sent')).toHaveCount(3);
    await expect(entry(page)).toHaveCount(0);
    await expect(sidebarWaiting(page)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('desktop-en-cards-and-sidebar-complete.png') });
    await page.reload();
    await expect(cards(page).getByText('Skipped · no answer sent')).toHaveCount(3);
    await expect(entry(page)).toHaveCount(0);
  } finally {
    firstGate.release();
    thirdGate.release();
    await info.attach('skip-event-order', {
      body: JSON.stringify({ events, submissions }, null, 2),
      contentType: 'application/json',
    });
  }
});

test('queued and uncertain skips stay with their thread through navigation and reload', async ({
  page,
  request,
}, info) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await send(page, 'Another session');
  const otherId = await page.locator('.thread-selected').getAttribute('data-thread-id');
  await createEmptyThread(page);
  await send(page, '[async-questions-multiple] Review settings');
  const threadId = await page.locator('.thread-selected').getAttribute('data-thread-id');
  const catalog = `/api/threads/${threadId}/questions`;
  const stale = (await (await request.get(catalog)).json()) as PendingQuestionsPage;
  expect(stale.data).toHaveLength(3);
  const link = (id: string) => page.locator(`.thread-link[data-thread-id="${id}"]`);
  const rows = dialog(page).locator('li');
  const skip = () => dialog(page).getByRole('button', { name: '跳过', exact: true });
  const responseGate = gate();
  const submissions: DismissQuestionsInput[] = [];
  const lookups: string[] = [];
  page.on('request', (req) => {
    const match = new URL(req.url()).pathname.match(/\/api\/operations\/([^/]+)$/);
    if (match) lookups.push(match[1]!);
  });
  await page.route('**/questions/dismiss', async (route) => {
    expect(new URL(route.request().url()).pathname).toBe(`${catalog}/dismiss`);
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      await responseGate.promise;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  try {
    await entry(page).click();
    await expect(rows).toHaveCount(3);
    await skip().first().click();
    await expect(rows).toHaveCount(2);
    await skip().first().click();
    await expect(rows).toHaveCount(1);
    await page.keyboard.press('Escape');
    await link(otherId!).click();
    await expect(link(otherId!)).toHaveClass(/thread-selected/);
    await expect(entry(page)).toHaveCount(0);
    await expect(sidebarWaiting(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);

    await link(threadId!).click();
    await page.route(`**${catalog}`, (route) => route.fulfill({ json: stale }), { times: 1 });
    await entry(page).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(stale.data[2]!.summary);
    expect(submissions).toHaveLength(1);
    responseGate.release();
    const original = submissions[0]!;
    await expect.poll(() => lookups.includes(original.clientOperationId)).toBe(true);
    await expect.poll(() => submissions.length).toBe(2);
    await expect(rows).toHaveCount(1);
    await expect(dialog(page).getByText('无法确认跳过结果。', { exact: false })).toBeVisible();
    const headers = { Origin: new URL(page.url()).origin };
    const external = await request.post(`${catalog}/dismiss`, {
      headers,
      data: { clientOperationId: crypto.randomUUID(), questionIds: [stale.data[2]!.id] },
    });
    expect(external.ok(), await external.text()).toBe(true);
    await expect(rows).toHaveCount(0);

    const languages = [
      ['zh-Hans', '查看待回答问题', '无法确认跳过结果。', 'dark'],
      ['ja', '未回答の質問を確認', 'スキップを確認できませんでした。', 'light'],
      ['ko', '답변 대기 질문 확인', '건너뛰기를 확인하지 못했습니다.', 'dark'],
    ] as const;
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [locale, menuItem, feedback, colorScheme] of languages) {
      await page.evaluate((locale) => localStorage.setItem('covro.locale', locale), locale);
      await page.emulateMedia({ colorScheme });
      await page.reload();
      await expect(cards(page)).not.toHaveCount(0);
      await expect(sidebarWaiting(page)).toHaveCount(0);
      await moreActions(page).click();
      await page.getByRole('button', { name: menuItem, exact: true }).click();
      await expect(dialog(page).getByText(feedback, { exact: false })).toBeVisible();
      await expect(rows).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: info.outputPath(`mobile-${locale}-skip-receipt-pending.png`) });
    }
    expect(submissions).toHaveLength(2);
    expect((await (await request.get(catalog)).json()).data).toHaveLength(1);

    // Deliver the original operation via the fixture client to model a delayed
    // request arriving after the browser lost its response. The browser only GETs it.
    const delivered = await request.post(`${catalog}/dismiss`, { headers, data: original });
    expect(delivered.ok(), await delivered.text()).toBe(true);
    await expect(dialog(page).getByText('답변 대기 중인 질문이 없습니다')).toBeVisible();
    await expect
      .poll(() => lookups.filter((id) => id === original.clientOperationId).length)
      .toBeGreaterThan(1);
    await expect
      .poll(async () =>
        page.evaluate(
          (id) => !localStorage.getItem('codex-web.operations.v1')?.includes(id),
          original.clientOperationId,
        ),
      )
      .toBe(true);
    await expect(entry(page)).toHaveCount(0);
    expect(submissions).toHaveLength(2);
  } finally {
    responseGate.release();
    await info.attach('skip-receipt-identities', {
      body: JSON.stringify({ submissions, lookups }, null, 2),
      contentType: 'application/json',
    });
  }
});

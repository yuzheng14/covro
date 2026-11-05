import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, RunStatus, ThreadSummary, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup, testOrigin } from './helpers';

const headers = { Origin: testOrigin };
const longTitle =
  '完整会话标题：检查来自 Web UI 的会话来源、键盘访问与触屏详情，确保省略的内容仍可阅读';
const link = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const threadRow = (page: Page, id: string) => link(page, id).locator('..');

async function submit(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(path, {
    headers,
    data: { clientOperationId: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}

async function create(request: APIRequestContext, title: string, project = 'fixture') {
  const operation = await submit(request, `/api/projects/${project}/threads`);
  const { threadId } = operation.result as { threadId: string };
  await submit(request, `/api/threads/${threadId}/rename`, { name: title });
  await submit(request, `/api/threads/${threadId}/turns`, { text: '已有会话历史 [title-fail]' });
  await expect
    .poll(async () => {
      const response = await request.get(`/api/threads/${threadId}`);
      return ((await response.json()) as ThreadView).turns.at(-1)?.status;
    })
    .toBe('completed');
  return threadId;
}

async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('compact rows retain keyboard-accessible full titles and creation details', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  test.setTimeout(90_000);
  await open(page);
  const ids: string[] = [];
  // Bound setup load on the deliberately fragmented RPC transport while retaining all 35 rows.
  for (let offset = 0; offset < 34; offset += 4) {
    ids.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(4, 34 - offset) }, (_, index) =>
          create(request, `会话 ${offset + index + 1}：检查项目配置与运行结果`),
        ),
      )),
    );
  }
  const id = await create(request, longTitle);
  ids.push(id);
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(page.locator(ids.map((id) => `[data-thread-id="${id}"]`).join(','))).toHaveCount(35);
  await page.locator('.project-list').evaluate((element) => {
    element.scrollTop = 0;
  });

  const metrics = await page.locator('.project-list').evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll('[data-thread-id]')].map((row) =>
      row.getBoundingClientRect(),
    );
    return {
      visibleRows: rows.filter((row) => row.top >= viewport.top && row.bottom <= viewport.bottom)
        .length,
      maximumHeight: Math.max(...rows.map((row) => row.height)),
    };
  });
  // At the same 1280×900 viewport the former three-line rows fit only four conversations.
  expect(metrics.visibleRows).toBeGreaterThanOrEqual(9);
  expect(metrics.maximumHeight).toBeLessThanOrEqual(40);
  const rowBounds = await link(page, id).boundingBox();
  expect(rowBounds).not.toBeNull();
  for (const button of await threadRow(page, id).locator('.thread-row-actions button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(rowBounds!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(rowBounds!.y + rowBounds!.height);
  }
  await expect(link(page, id).locator('.thread-progress')).toHaveCount(0);
  const title = link(page, id).locator('.thread-title');
  expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  const compact = testInfo.outputPath('sidebar-compact-desktop.png');
  await page.screenshot({ path: compact, animations: 'disabled' });
  await testInfo.attach('sidebar-compact-desktop', { path: compact, contentType: 'image/png' });
  await testInfo.attach('sidebar-density', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });

  const detailsButton = page.getByRole('button', { name: `会话详情：${longTitle}`, exact: true });
  await detailsButton.focus();
  await expect(detailsButton).toBeFocused();
  await detailsButton.press('Enter');
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
  const details = threadRow(page, id).locator('.thread-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText(longTitle);
  await expect(details).toContainText('Web');
  await expect(details).toContainText('由 Covro（本网页）创建。');
  await expect(details).toContainText('已完成');
  await expect(link(page, id)).not.toHaveAttribute('aria-current', 'page');
  const expanded = testInfo.outputPath('sidebar-details-keyboard.png');
  await page.screenshot({ path: expanded, animations: 'disabled' });
  await testInfo.attach('sidebar-details-keyboard', { path: expanded, contentType: 'image/png' });
  await detailsButton.press('Space');
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(details).not.toBeVisible();

  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        data: result.data.map((thread: ThreadSummary) =>
          thread.id === id ? { ...thread, originator: null, source: 'vscode' } : thread,
        ),
      },
    });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await detailsButton.click();
  await expect(details).toContainText('交互客户端');
  await expect(details).toContainText('无法确认具体创建客户端');
  await detailsButton.press('Escape');
  await expect(detailsButton).toBeFocused();
  await expect(details).not.toBeVisible();
});

test('all execution states remain single-line with accessible icons and pending details', async ({
  page,
  request,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const states: {
    status: RunStatus;
    label: string;
    lastTurnStatus?: RunStatus;
    pending?: number;
    pendingQuestions?: number;
  }[] = [
    { status: 'running', label: '执行中' },
    { status: 'waitingApproval', label: '等待审批', pending: 2 },
    { status: 'waitingInput', label: '等待回答', pending: 1 },
    { status: 'waitingInput', label: '等待回答', pending: 1, pendingQuestions: 2 },
    { status: 'waitingInput', label: '等待回答', pendingQuestions: 2 },
    { status: 'idle', lastTurnStatus: 'failed', label: '失败' },
    { status: 'idle', lastTurnStatus: 'interrupted', label: '已中断' },
    { status: 'unknown', label: '状态待核对' },
    { status: 'idle', lastTurnStatus: 'completed', label: '已完成' },
    { status: 'idle', label: '就绪' },
  ];
  const ids = await Promise.all(
    states.map((state, index) => create(request, `${index + 1} · ${state.label}的会话`)),
  );
  // Keep real gateway identities and navigation while covering all persisted summary states.
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        data: result.data.map((thread: ThreadSummary) => {
          const state = states[ids.indexOf(thread.id)];
          return state
            ? {
                ...thread,
                status: state.status,
                lastTurnStatus: state.lastTurnStatus,
                lastTurnId: state.lastTurnStatus ? `fixture-turn-${thread.id}` : undefined,
                pendingActionCount: state.pending ?? 0,
                pendingQuestionCount: state.pendingQuestions ?? 0,
              }
            : thread;
        }),
      },
    });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  for (const [index, state] of states.entries()) {
    const row = threadRow(page, ids[index]!);
    const threadLink = link(page, ids[index]!);
    const indicator = row.locator('.thread-status-indicator');
    const detailsButton = row.locator('.thread-details-trigger');
    await expect(threadLink.locator('.thread-progress')).toHaveCount(0);
    await expect(threadLink.locator('.sr-only')).toContainText(state.label);
    const rowBounds = await threadLink.boundingBox();
    expect(rowBounds).not.toBeNull();
    expect(rowBounds!.height).toBeLessThanOrEqual(40);
    if (state.status === 'idle' && !state.lastTurnStatus) {
      await expect(indicator).toHaveCount(0);
      continue;
    }
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('role', 'img');
    await expect(indicator).toHaveAttribute('data-status', state.lastTurnStatus ?? state.status);
    await expect(indicator).toHaveAccessibleName(new RegExp(state.label));
    if (state.lastTurnStatus === 'completed')
      await expect(indicator).toHaveAccessibleName('已完成 · 未读');
    expect(await indicator.evaluate((element) => element.tagName)).toBe('SPAN');
    expect(
      await indicator.evaluate((element) => element.parentElement?.firstElementChild === element),
    ).toBe(true);
    await expect(row.locator('.thread-row-actions > .thread-status-indicator')).toHaveCount(1);

    const iconBounds = await indicator.boundingBox();
    const detailsBounds = await detailsButton.boundingBox();
    expect(iconBounds).not.toBeNull();
    expect(detailsBounds).not.toBeNull();
    expect(iconBounds!.y).toBeGreaterThanOrEqual(rowBounds!.y);
    expect(iconBounds!.y + iconBounds!.height).toBeLessThanOrEqual(
      rowBounds!.y + rowBounds!.height,
    );
    expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(detailsBounds!.x);

    const glyph = indicator.locator('.thread-status-glyph');
    await expect(glyph).toHaveCount(1);
    if (state.status === 'running') await expect(glyph).toHaveClass(/thread-status-spinning/);
    else await expect(glyph).not.toHaveClass(/thread-status-spinning/);

    const pendingCount = (state.pending ?? 0) + (state.pendingQuestions ?? 0);
    if (pendingCount) {
      const combinedLabel = `${pendingCount} 项待处理`;
      await expect(indicator).toHaveAccessibleName(new RegExp(combinedLabel));
      await expect(threadLink.locator('.sr-only')).toContainText(combinedLabel);
      await expect(indicator.locator('.thread-status-notification')).toHaveCount(1);
    }
    if (state.pending) {
      const pendingLabel = `${state.pending} 项待处理`;
      await detailsButton.click();
      await expect(row.locator('.thread-details')).toContainText(state.label);
      await expect(row.locator('.thread-details')).toContainText(pendingLabel);
      await detailsButton.click();
    }
  }
  const runningGlyph = threadRow(page, ids[0]!).locator('.thread-status-glyph');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(runningGlyph).toHaveCSS('animation-name', 'thread-status-spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(runningGlyph).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(runningGlyph).toHaveCSS('animation-name', 'thread-status-spin');
  await link(page, ids[0]!).scrollIntoViewIfNeeded();
  const statesScreenshot = testInfo.outputPath('sidebar-critical-states.png');
  await page.screenshot({ path: statesScreenshot, animations: 'disabled' });
  await testInfo.attach('sidebar-critical-states', {
    path: statesScreenshot,
    contentType: 'image/png',
  });
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  for (const id of ids.slice(0, 3)) {
    await expect(threadRow(page, id).locator('.thread-status-indicator')).toHaveAccessibleName(
      /上次已知：/,
    );
    await expect(link(page, id).locator('.sr-only')).toContainText('上次已知：');
  }
  const stoppedSpinner = threadRow(page, ids[0]!).locator('.thread-status-glyph');
  await expect(stoppedSpinner).not.toHaveClass(/thread-status-spinning/);
  await expect(stoppedSpinner).toHaveCSS('animation-name', 'none');
});

test.describe('touch navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('touch details, search, switching and loading another page stay usable', async ({
    page,
    request,
  }, testInfo) => {
    await open(page);
    const first = await create(request, longTitle);
    const second = await create(request, '第二页：继续核对创建来源');
    let pageReads = 0;
    await page.route('**/api/projects/fixture/threads*', async (route) => {
      pageReads++;
      const response = await route.fetch();
      const result = await response.json();
      const more = new URL(route.request().url()).searchParams.has('cursor');
      await route.fulfill({
        response,
        json: {
          ...result,
          data: result.data
            .filter((thread: ThreadSummary) => thread.id === (more ? second : first))
            .map((thread: ThreadSummary) =>
              thread.id === first
                ? { ...thread, status: 'waitingApproval', pendingActionCount: 2 }
                : thread,
            ),
          nextCursor: more ? null : 'sidebar-second-page',
        },
      });
    });
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await page.getByRole('button', { name: '刷新会话列表' }).tap();
    await expect(link(page, first)).toBeVisible();
    // A partial refresh preserves the already loaded second row.
    await expect(link(page, second)).toBeVisible();
    await expect(threadRow(page, first).locator('.thread-status-indicator')).toHaveAccessibleName(
      '等待审批 · 2 项待处理',
    );
    const detailsButton = page.getByRole('button', { name: `会话详情：${longTitle}`, exact: true });
    await detailsButton.tap();
    await expect(threadRow(page, first).locator('.thread-details')).toContainText(longTitle);
    await expect(threadRow(page, first).locator('.thread-details')).toContainText('等待审批');
    await expect(threadRow(page, first).locator('.thread-details')).toContainText('2 项待处理');
    await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await threadRow(page, first).evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const screenshot = testInfo.outputPath('sidebar-details-touch.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    await testInfo.attach('sidebar-details-touch', { path: screenshot, contentType: 'image/png' });
    await detailsButton.tap();
    await projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }).tap();
    await expect(projectGroup(page).getByText('已加载全部会话', { exact: true })).toBeVisible();
    await expect(link(page, second)).toBeVisible();
    const search = page.getByRole('searchbox', { name: '搜索项目与已加载会话' });
    await search.fill('第二页');
    await expect(link(page, first)).toHaveCount(0);
    await expect(link(page, second)).toBeVisible();
    await link(page, second).tap();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
    await expect(page.locator('.topbar h1')).toHaveText('第二页：继续核对创建来源');
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await search.fill('');
    const before = pageReads;
    await projectGroup(page, '另一个项目')
      .getByRole('button', { name: '另一个项目', exact: true })
      .tap();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await projectGroup(page)
      .getByRole('button', { name: /^测试项目(?:\s|$)/ })
      .tap();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await expect(link(page, first)).toBeVisible();
    await expect(link(page, second)).toBeVisible();
    await expect(
      projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }),
    ).toHaveCount(0);
    expect(pageReads).toBe(before);
  });
});

import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { ThreadSummary, ThreadSummaryPage } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';

const summary = (
  id: string,
  updatedAt = 1000,
  projectId = 'fixture',
  archived = false,
): ThreadSummary => ({
  id,
  title: `会话 ${id} · 性能验证`,
  projectId,
  updatedAt,
  archived,
  source: 'appServer',
  status: 'running',
  managed: true,
  pendingActionCount: 2,
});
const pageOf = (
  data: ThreadSummary[],
  nextCursor: string | null = null,
  seq = 1,
): ThreadSummaryPage => ({
  data,
  nextCursor,
  cursor: { serverEpoch: 'list-cache-test', seq },
});
const row = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const more = (page: Page) =>
  projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true });
async function waitForCache(page: Page, count: number, archived = false) {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ count, archived }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('covro-conversation-history');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          try {
            const tx = db.transaction('pages');
            const keys = await new Promise<IDBValidKey[]>((resolve) => {
              const req = tx.objectStore('pages').getAllKeys();
              req.onsuccess = () => resolve(req.result);
            });
            const key = keys.find((key) => {
              const parts = JSON.parse(String(key)) as string[];
              return (
                parts[1] === 'fixture' &&
                parts[2] === 'thread-list' &&
                parts[4] === (archived ? 'archived' : 'active')
              );
            });
            if (!key) return false;
            const value = await new Promise<{ json: string }>((resolve) => {
              const req = db.transaction('pages').objectStore('pages').get(key);
              req.onsuccess = () => resolve(req.result);
            });
            return (JSON.parse(value.json) as ThreadSummary[]).length === count;
          } finally {
            db.close();
          }
        },
        { count, archived },
      ),
    )
    .toBe(true);
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('loads the preferred project first and bounds other startup reads', async ({ page }, info) => {
  const projects = Array.from({ length: 6 }, (_, i) => ({
    id: `startup-${i}`,
    name: `测试项目 ${i}`,
    rootPath: `/fixture/startup-${i}`,
    canonicalRoot: `/fixture/startup-${i}`,
    workspaceKey: `/fixture/startup-${i}`,
    available: true,
  }));
  const preferred = projects.at(-1)!;
  await page.addInitScript((id) => localStorage.setItem('codex-web.project', id), preferred.id);
  let overviewReads = 0;
  let releaseOverview!: () => void;
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve;
  });
  await page.route('**/api/projects', async (route) => {
    overviewReads++;
    await overviewGate;
    return route.fulfill({ json: { data: projects } });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested: string[] = [];
  let pending = 0;
  let peak = 0;
  await page.route(/\/api\/(?:projects\/startup-\d+|unassigned)\/threads$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    requested.push(id);
    peak = Math.max(peak, ++pending);
    if (id !== preferred.id) await gate;
    pending--;
    await route.fulfill({ json: pageOf(id === 'unassigned' ? [] : [summary(id, 1000, id)]) });
  });

  try {
    await page.goto('/');
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    releaseOverview();
    await expect(row(page, preferred.id)).toBeVisible();
    await expect.poll(() => requested.length).toBe(5);
    expect(overviewReads).toBe(1);
    expect(new Set(requested).size).toBe(5);
    expect(peak).toBeLessThanOrEqual(4);
    await page.screenshot({ path: info.outputPath('preferred-project-first.png') });
  } finally {
    releaseOverview();
    release();
  }
  await expect.poll(() => requested.length).toBe(7);
  expect(overviewReads).toBe(1);
  expect(new Set(requested).size).toBe(7);
  expect(peak).toBeLessThanOrEqual(4);
});

test('shows a partial cached list before HTTP, reconciles incrementally and preserves the visible row during sorting', async ({
  page,
}, info) => {
  const rows = Array.from({ length: 48 }, (_, i) => summary(`item-${i}`, 1000 - i));
  const calls: (string | null)[] = [];
  const payloadBytes: number[] = [];
  let warm = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    calls.push(cursor);
    if (!warm) await new Promise((resolve) => setTimeout(resolve, 600));
    else if (!cursor) await Promise.all([gate, new Promise((resolve) => setTimeout(resolve, 600))]);
    const response = !warm
      ? pageOf(cursor ? rows.slice(24) : rows.slice(0, 24), cursor ? null : 'second')
      : pageOf(
          cursor
            ? rows.slice(24).filter((r) => r.id !== 'item-40')
            : [
                summary('new', 2000),
                { ...rows[0]!, title: '另一设备修改的标题' },
                ...rows.slice(1, 24),
              ],
          cursor ? null : 'second',
          2,
        );
    payloadBytes.push(Buffer.byteLength(JSON.stringify(response)));
    await route.fulfill({ json: response });
  });
  const coldStart = Date.now();
  await open(page);
  await expect(row(page, 'item-0')).toBeVisible();
  const coldVisibleMs = Date.now() - coldStart;
  // Store a partial result, not the full upstream list.
  await waitForCache(page, 24);
  warm = true;
  calls.length = 0;
  payloadBytes.length = 0;
  const warmStart = Date.now();
  await page.reload();
  await expect(row(page, 'item-0')).toBeVisible();
  await expect(projectGroup(page).getByText('正在显示本机列表，后台同步中…')).toBeVisible();
  const cacheVisibleMs = Date.now() - warmStart;
  await expect(row(page, 'item-0')).toContainText('状态待核对');
  await page.getByRole('navigation', { name: '会话历史' }).evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await page.screenshot({ path: info.outputPath('list-cache-syncing.png') });
  expect(calls).toEqual([null]);
  const list = page.getByRole('navigation', { name: '会话历史' });
  await list.evaluate((list) => {
    list.scrollTop = 310;
  });
  const anchor = await row(page, 'item-9').boundingBox();
  release();
  await expect(row(page, 'item-0')).toContainText('另一设备修改的标题');
  const syncedMs = Date.now() - warmStart;
  const after = await row(page, 'item-9').boundingBox();
  expect(Math.abs(after!.y - anchor!.y)).toBeLessThan(3);
  expect(calls).toEqual([null]);
  await more(page).click();
  await expect(row(page, 'item-47')).toBeAttached();
  await expect(row(page, 'item-40')).toHaveCount(0);
  await expect(projectGroup(page).getByText('已加载全部会话')).toBeAttached();
  expect(calls).toEqual([null, 'second']);
  await page.screenshot({ path: info.outputPath('list-cache-reconciled.png') });
  await writeFile(
    info.outputPath('list-cache-metrics.json'),
    JSON.stringify(
      {
        coldVisibleMs,
        cacheVisibleMs,
        syncedMs,
        requests: calls,
        rowsPerRequest: [25, 23],
        payloadBytes,
        scrollOffsetPx: Math.abs(after!.y - anchor!.y),
      },
      null,
      2,
    ),
  );
});

test('keeps cached rows readable on failure and retries without carrying cached runtime state', async ({
  page,
}, info) => {
  let failed = false;
  const rows = [summary('one'), summary('archived-elsewhere'), summary('three')];
  await page.route('**/api/projects/fixture/threads*', (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: '服务暂时不可达' } } }
        : { json: pageOf(rows) },
    ),
  );
  await open(page);
  await expect(row(page, 'one')).toBeVisible();
  await waitForCache(page, 3);
  failed = true;
  await page.reload();
  await expect(projectGroup(page).getByText('本机列表同步失败，可继续浏览。')).toBeVisible();
  await expect(row(page, 'one')).toContainText('状态待核对');
  await expect(row(page, 'archived-elsewhere')).toBeVisible();
  await page.screenshot({ path: info.outputPath('list-cache-failed.png') });
  failed = false;
  rows.splice(1, 1);
  rows[0] = { ...rows[0]!, status: 'idle', pendingActionCount: 0, title: '恢复网络后的标题' };
  await projectGroup(page).getByRole('button', { name: '加载失败，重试', exact: true }).click();
  await expect(row(page, 'one')).toContainText('恢复网络后的标题');
  await expect(row(page, 'archived-elsewhere')).toHaveCount(0);
  await expect(projectGroup(page).getByText('本机列表同步失败，可继续浏览。')).toHaveCount(0);
});

test('isolates archived lists, projects and late requests during rapid filter switches', async ({
  page,
}, info) => {
  let delayed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/*/threads*', async (route) => {
    const url = new URL(route.request().url());
    const project = url.pathname.includes('fixture-other') ? 'fixture-other' : 'fixture';
    const archived = url.searchParams.has('archived');
    if (delayed && !archived) await gate;
    await route.fulfill({
      json: pageOf([summary(`${project}-${archived}`, 1, project, archived)]),
    });
  });
  await open(page);
  await expect(row(page, 'fixture-false')).toBeVisible();
  await waitForCache(page, 1);
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(row(page, 'fixture-true')).toBeVisible();
  await waitForCache(page, 1, true);
  delayed = true;
  const filterStart = Date.now();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(row(page, 'fixture-false')).toBeVisible();
  const filterCacheMs = Date.now() - filterStart;
  await expect(row(page, 'fixture-true')).toHaveCount(0);
  const projectStart = Date.now();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: /^另一个项目/ })
    .click();
  await expect(
    projectGroup(page, '另一个项目').locator('[data-thread-id="fixture-other-false"]'),
  ).toBeVisible();
  const projectSwitchMs = Date.now() - projectStart;
  await expect(
    projectGroup(page, '另一个项目').locator('[data-thread-id="fixture-false"]'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(row(page, 'fixture-true')).toBeVisible();
  release();
  await expect(row(page, 'fixture-false')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('list-cache-filter-isolation.png') });
  await writeFile(
    info.outputPath('list-cache-switch-metrics.json'),
    JSON.stringify({ filterCacheMs, projectSwitchMs }),
  );
});

test('retains unseen cached tails until explicit pagination completes and keeps the selection stable', async ({
  page,
}, info) => {
  const rows = Array.from({ length: 12 }, (_, i) => summary(`tail-${i}`, 100 - i));
  let warm = false;
  const calls: (string | null)[] = [];
  await page.route('**/api/projects/fixture/threads*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    calls.push(cursor);
    return route.fulfill({
      json: !warm
        ? pageOf(rows)
        : cursor === null
          ? pageOf(
              [{ ...rows[3]!, updatedAt: 999, title: '另一个设备的新标题' }, ...rows.slice(0, 3)],
              'second',
              2,
            )
          : cursor === 'second'
            ? pageOf(rows.slice(4, 8), 'third', 3)
            : pageOf(rows.slice(8, 11), null, 4),
    });
  });
  await page.route('**/api/threads/tail-3', (route) =>
    route.fulfill({
      json: {
        ...rows[3],
        cwd: '/',
        turns: [],
        actions: [],
        historyVisible: true,
        history: { olderCursor: null },
      },
    }),
  );
  await open(page);
  await expect(row(page, 'tail-11')).toBeAttached();
  await waitForCache(page, 12);
  warm = true;
  calls.length = 0;
  await page.reload();
  await expect(row(page, 'tail-3')).toContainText('另一个设备的新标题');
  await expect(row(page, 'tail-11')).toBeAttached();
  await expect(row(page, 'tail-11')).toContainText('状态待核对');
  await expect(
    projectGroup(page).getByText('部分本机列表尚未同步，加载更多以核对。'),
  ).toBeAttached();
  await expect(projectGroup(page).getByText('已加载全部会话')).toHaveCount(0);
  await row(page, 'tail-3').click();
  await expect(row(page, 'tail-3')).toHaveAttribute('aria-current', 'page');
  await more(page).click();
  await expect(row(page, 'tail-4')).toContainText('执行中');
  expect(calls).toEqual([null, 'second']);
  await more(page).click();
  await expect(row(page, 'tail-11')).toHaveCount(0);
  await expect(row(page, 'tail-3')).toHaveAttribute('aria-current', 'page');
  await expect(projectGroup(page).getByText('已加载全部会话')).toBeAttached();
  await writeFile(
    info.outputPath('list-cache-pagination-metrics.json'),
    JSON.stringify({ requests: calls, selectedId: 'tail-3', cachedRows: 12, finalRows: 11 }),
  );
});

test('does not reuse another authenticated namespace or restore cache after access is denied', async ({
  page,
}) => {
  let namespace = 'first-user-server';
  let denied = false;
  let pending = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/history-cache-context', (route) =>
    route.fulfill({ json: { scope: namespace } }),
  );
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    if (pending) await gate;
    await route.fulfill(
      denied
        ? { status: 403, json: { error: { code: 'FORBIDDEN', message: '访问已撤销' } } }
        : { json: pageOf([summary('private-list')]) },
    );
  });
  await open(page);
  await expect(row(page, 'private-list')).toBeVisible();
  await waitForCache(page, 1);
  namespace = 'second-user-server';
  pending = true;
  await page.reload();
  await expect(projectGroup(page).getByRole('button', { name: '正在同步会话…' })).toBeVisible();
  await expect(row(page, 'private-list')).toHaveCount(0);
  release();
  await expect(row(page, 'private-list')).toBeVisible();
  await waitForCache(page, 1);
  denied = true;
  await page.reload();
  await expect(projectGroup(page).getByRole('button', { name: '加载失败，重试' })).toBeVisible();
  await expect(row(page, 'private-list')).toHaveCount(0);
  await expect(projectGroup(page).getByText('本机列表同步失败，可继续浏览。')).toHaveCount(0);
});

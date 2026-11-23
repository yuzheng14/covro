import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  selectInterfaceLocale,
  testOrigin,
} from './helpers';
import type { ServerMessage, ThreadView } from '../../src/shared/types';

async function newSession(page: Page) {
  await createEmptyThread(page);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}

const row = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const body = (page: Page) => page.locator('.conversation-content');
const state = (page: Page, id: string) =>
  row(page, id).locator('..').locator('.thread-status-indicator');

async function run(request: APIRequestContext, id: string, text: string) {
  const result = await request.post(`/api/threads/${id}/turns`, {
    data: { clientOperationId: randomUUID(), text },
    headers: { Origin: testOrigin },
  });
  expect(result.ok()).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});

test('opens the completed background conversation with its final content in the first frame', async ({
  page,
  request,
}, testInfo) => {
  const a = await newSession(page);
  const b = await newSession(page);
  const final = '下一轮我会先选';
  await run(request, a, '会话 A · 检查配置 [context-compact-hold]');
  await run(request, b, '会话 B · 整理操作计划 [markdown]');
  await expect(body(page).getByText('我建议优先做下面几组，按当前支持情况排序：')).toBeVisible();
  await expect(state(page, a)).toHaveAccessibleName('执行中');
  await row(page, a).click();
  await expect(body(page).getByText('会话 A · 检查配置 [context-compact-hold]')).toBeVisible();
  await expect(state(page, b)).toHaveAccessibleName(/已完成/);
  await expect(state(page, a)).toHaveAccessibleName('执行中');
  await page.screenshot({ path: testInfo.outputPath('a-visible-b-completed.png') });

  const initial = '我建议优先做下面几组';
  const detailReads: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path === `/api/threads/${b}` || path === `/api/threads/${b}/snapshot`)
      detailReads.push(path.replace(b, 'B'));
  });
  const frames = await row(page, b).evaluate(
    (link, { final, initial }) =>
      new Promise<{ ms: number; final: boolean; initial: boolean; state: string }[]>((resolve) => {
        const started = performance.now();
        const samples: { ms: number; final: boolean; initial: boolean; state: string }[] = [];
        const observe = () => {
          const body = document.querySelector('.conversation-content')?.textContent ?? '';
          const state =
            Array.from(document.querySelectorAll('.turn-heading .status')).at(-1)?.textContent ??
            '';
          const sample = {
            ms: +(performance.now() - started).toFixed(1),
            final: body.includes(final),
            initial: body.includes(initial),
            state,
          };
          const previous = samples.at(-1);
          if (
            !previous ||
            previous.final !== sample.final ||
            previous.initial !== sample.initial ||
            previous.state !== sample.state
          )
            samples.push(sample);
          if ((sample.final && sample.state === '已完成') || sample.ms > 4000) resolve(samples);
          else requestAnimationFrame(observe);
        };
        (link as HTMLElement).click();
        requestAnimationFrame(observe);
      }),
    { final, initial },
  );
  await expect(body(page).getByText(final, { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('b-completed.png') });
  await writeFile(
    testInfo.outputPath('switch-timing.json'),
    JSON.stringify({ frames, detailReads }, null, 2),
  );
  expect(frames[0]).toMatchObject({ final: true, state: '已完成' });
  expect(detailReads).toEqual([]);

  for (const [locale, width, colorScheme] of [
    ['en', 1280, 'light'],
    ['ja', 390, 'dark'],
    ['ko', 390, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await selectInterfaceLocale(page, locale);
    await expect(body(page).getByText(final, { exact: false })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.screenshot({ path: testInfo.outputPath(`b-completed-${locale}.png`) });
  }
});

test('shows progress received in the background and appends later live output once', async ({
  page,
  request,
}, testInfo) => {
  // Preserve real gateway frames and hold B's updates after its second chunk until
  // the first return is observed, independent of Chromium scheduling under CI load.
  let target: string | undefined;
  let progress = false;
  let release = () => {};
  await page.routeWebSocket('**/ws?overview=1', (browser) => {
    const server = browser.connectToServer();
    const pending: string[] = [];
    let hold = false;
    release = () => {
      hold = false;
      for (const frame of pending.splice(0)) browser.send(frame);
    };
    server.onMessage((raw) => {
      const frame = raw.toString();
      const event = JSON.parse(frame) as ServerMessage;
      if (target && event.threadId === target) {
        if (hold) {
          pending.push(frame);
          return;
        }
        if (
          !progress &&
          event.type === 'event' &&
          event.kind === 'threadPatch' &&
          JSON.stringify(event.payload).includes('Copy & export')
        ) {
          progress = true;
          hold = true;
        }
      }
      browser.send(raw);
    });
  });
  await page.reload();
  const c = await newSession(page);
  const a = await newSession(page);
  const b = await newSession(page);
  target = b;
  await run(request, c, '会话 C · 独立运行 [context-compact-hold]');
  await run(request, a, '会话 A · 检查配置 [context-compact-hold]');
  await run(request, b, '会话 B · 整理操作计划 [markdown]');
  await expect(body(page).getByText('我建议优先做下面几组，按当前支持情况排序：')).toBeVisible();
  await row(page, a).click();
  await expect(state(page, c)).toHaveAccessibleName('执行中');
  await expect.poll(() => progress).toBe(true);
  await row(page, b).click();
  await expect(body(page)).toContainText('Copy & export');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('执行中');
  await expect(body(page)).not.toContainText('下一轮我会先选');
  await page.screenshot({ path: testInfo.outputPath('b-in-progress.png') });
  for (const id of [c, a, b, a, c, b]) await row(page, id).click();
  release();
  await expect(body(page).getByText('下一轮我会先选', { exact: false })).toHaveCount(1);
  await expect(body(page)).toContainText('Copy & export');
  await expect(body(page)).not.toContainText('独立运行');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('reconnects a background session after it finishes offline without submitting again', async ({
  page,
  request,
  context,
}) => {
  const a = await newSession(page);
  const b = await newSession(page);
  await run(request, a, '会话 A · 检查配置 [context-compact-hold]');
  await run(request, b, '会话 B · 整理操作计划 [markdown]');
  await expect(body(page).getByText('我建议优先做下面几组，按当前支持情况排序：')).toBeVisible();
  await row(page, a).click();
  await context.setOffline(true);
  await expect
    .poll(async () => {
      const response = await request.get(`/api/threads/${b}`);
      return ((await response.json()) as ThreadView).turns.at(-1)?.status;
    })
    .toBe('completed');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/turns')) writes.push(request.url());
  });
  await context.setOffline(false);
  await expect(state(page, b)).toHaveAccessibleName(/已完成/);
  await row(page, b).click();
  await expect(body(page).getByText('下一轮我会先选', { exact: false })).toHaveCount(1);
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(writes).toEqual([]);
});

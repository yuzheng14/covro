import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const notice = (page: Page) => page.locator('.session-resume-notice');
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
async function openExternal(
  page: Page,
  request: APIRequestContext,
  state: 'free' | 'occupied' | 'error',
) {
  const { externalThreadId: id } = await controlRuntime(request, { external: state });
  await page.addInitScript((id) => {
    localStorage.setItem('codex-web.project', 'fixture');
    localStorage.setItem('codex-web.selected:fixture', id!);
  }, id);
  await page.goto('/');
  await confirmCompatibility(page);
  return id!;
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('free history resumes once automatically and survives reload without confirmation', async ({
  page,
  request,
}) => {
  let resumes = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/resume')) resumes++;
  });
  const id = await openExternal(page, request, 'free');
  await input(page).fill('恢复后继续');
  await expect(send(page)).toBeEnabled();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByText('外部会话 · 活动状态未知')).toHaveCount(0);
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  expect(resumes).toBe(1);
  await page.reload();
  await expect(
    page.locator('.conversation-content').getByText('已保存的会话历史', { exact: true }),
  ).toBeVisible();
  await input(page).fill('刷新后继续');
  await expect(send(page)).toBeEnabled();
  expect(resumes).toBe(1);
  await page.screenshot({ path: '/tmp/codex-occupancy-free.png', fullPage: true });
  await send(page).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  expect((await (await request.get(`/api/threads/${id}`)).json()).turns).toHaveLength(2);
});

test('only a real conflict shows Fork; Enter stays blocked and release + retry preserves the draft', async ({
  page,
  request,
}) => {
  let resumes = 0;
  let turns = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/resume')) resumes++;
    if (req.method() === 'POST' && req.url().endsWith('/turns')) turns++;
  });
  const id = await openExternal(page, request, 'occupied');
  await expect(notice(page)).toContainText('此会话正被其他进程使用');
  await expect(notice(page).getByRole('checkbox')).toHaveCount(0);
  await expect(notice(page).getByRole('button', { name: 'Fork 为新会话' })).toBeEnabled();
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  await input(page).fill('释放后保留这份草稿');
  await expect(send(page)).toBeDisabled();
  await input(page).press('Enter');
  await page.screenshot({ path: '/tmp/codex-occupancy-blocked.png', fullPage: true });
  expect(turns).toBe(0);
  expect(resumes).toBe(1);
  await controlRuntime(request, { releaseThreadId: id });
  await expect(notice(page)).toBeVisible();
  expect(resumes).toBe(1);
  await notice(page).getByRole('button', { name: '重试恢复' }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('释放后保留这份草稿');
  expect(resumes).toBe(2);
});

test('occupied history can fork on mobile without stopping or retrying the original', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await openExternal(page, request, 'occupied');
  await expect(notice(page)).toBeVisible();
  await page.screenshot({ path: '/tmp/codex-occupancy-mobile.png', fullPage: true });
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(req.url());
  });
  await notice(page).getByRole('button', { name: 'Fork 为新会话' }).click();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(
    page.locator('.conversation-content').getByText('已保存的会话历史', { exact: true }),
  ).toBeVisible();
  await input(page).fill('在副本继续');
  await expect(send(page)).toBeEnabled();
  expect(posts.filter((url) => /\/(resume|interrupt)$/.test(url))).toEqual([]);
  expect((await (await request.get(`/api/threads/${id}`)).json()).managed).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('ordinary resume errors show their actual cause and can be retried', async ({
  page,
  request,
}) => {
  await openExternal(page, request, 'error');
  await expect(notice(page)).toContainText('无法恢复会话');
  await expect(notice(page)).toContainText('测试历史格式无法恢复');
  await expect(notice(page).getByText('此会话正被其他进程使用')).toHaveCount(0);
  await expect(notice(page).getByRole('button', { name: 'Fork 为新会话' })).toHaveCount(0);
  await expect(notice(page).getByRole('button', { name: '重试恢复' })).toBeEnabled();
});

test('switching during automatic resume cannot replace the newly selected thread or its draft', async ({
  page,
  request,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/resume', async (route) => {
    await gate;
    await route.continue();
  });
  const id = await openExternal(page, request, 'free');
  await expect(page.getByText('正在恢复会话…', { exact: true })).toBeVisible();
  await createEmptyThread(page);
  await expectThreadReady(page);
  await input(page).fill('新会话草稿');
  release();
  await expect
    .poll(async () => (await (await request.get(`/api/threads/${id}`)).json()).managed)
    .toBe(true);
  await expect(input(page)).toHaveValue('新会话草稿');
  expect(await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'))).not.toBe(
    id,
  );
});

test('an uncertain resume is not retried automatically after refresh', async ({
  page,
  request,
}) => {
  let resumes = 0;
  await page.route('**/api/threads/*/resume', async (route) => {
    resumes++;
    await route.abort('failed');
  });
  await openExternal(page, request, 'free');
  await expect(page.locator('.pending-notice')).toBeVisible();
  expect(resumes).toBe(1);
  await page.reload();
  await expect(page.locator('.pending-notice')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(send(page)).toBeDisabled();
  expect(resumes).toBe(1);
});

test('after explicitly resolving a lost resume receipt, recovery can be retried without losing the draft', async ({
  page,
  request,
}) => {
  await page.route('**/api/threads/*/resume', (route) => route.abort('failed'));
  await openExternal(page, request, 'free');
  await expect(page.locator('.pending-notice')).toBeVisible();
  await input(page).fill('核对后继续');
  await page.locator('.pending-notice').getByRole('button', { name: '核对提交' }).click();
  const panel = page.getByRole('region', { name: '状态诊断详情' });
  await panel.getByRole('button', { name: '解除本页限制…' }).click();
  await page.unroute('**/api/threads/*/resume');
  const recovery = page.getByRole('dialog', { name: '解除本页限制' });
  await expect(recovery).toContainText('不会停止任务或重新发送');
  await recovery.getByRole('button', { name: '解除本页限制', exact: true }).click();
  await page.getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('核对后继续');
});

test('expanded technical error details are readable in both themes and narrow layouts', async ({
  page,
  request,
}, info) => {
  await openExternal(page, request, 'error');
  await notice(page).locator('.raw-details > summary').click();
  const details = notice(page).locator('.raw-details pre');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(details).toBeVisible();
      const metrics = await details.evaluate((element) => {
        const rgba = (value: string) => {
          const parts = value.match(/[\d.]+/g)?.map(Number);
          if (!parts || parts.length < 3 || parts.some((part) => !Number.isFinite(part)))
            throw new Error('Invalid computed RGB color');
          return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] as const;
        };
        let background = [255, 255, 255];
        const ancestors: Element[] = [];
        for (let parent: Element | null = element; parent; parent = parent.parentElement)
          ancestors.unshift(parent);
        for (const parent of ancestors) {
          const [r, g, b, alpha] = rgba(getComputedStyle(parent).backgroundColor);
          background = [r, g, b].map(
            (value, index) => value * alpha + background[index]! * (1 - alpha),
          );
        }
        const style = getComputedStyle(element);
        const luminance = (rgb: readonly number[]) =>
          rgb
            .slice(0, 3)
            .map((value) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const foreground = luminance(rgba(style.color));
        const back = luminance(background);
        return {
          contrast: (Math.max(foreground, back) + 0.05) / (Math.min(foreground, back) + 0.05),
          fontSize: parseFloat(style.fontSize),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(metrics.contrast).toBeGreaterThanOrEqual(4.5);
      expect(metrics.fontSize).toBeGreaterThanOrEqual(12);
      expect(metrics.overflow).toBe(false);
      await expect(notice(page).getByRole('button', { name: '重试恢复' })).toBeEnabled();
      const path = info.outputPath(`error-details-${theme}-${width}.png`);
      await notice(page).screenshot({ path });
      await info.attach(`error-details-${theme}-${width}`, { path, contentType: 'image/png' });
    }
  }
});

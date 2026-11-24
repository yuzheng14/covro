import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const preview = (page: Page) =>
  page.getByRole('dialog', { name: 'Markdown 文件预览', exact: true });
const fileLink = (page: Page) => page.getByRole('link', { name: '阅读实施方案', exact: true });
const original =
  '# Markdown 文件预览\n\n在会话旁阅读方案，随时补充想法。\n\n' +
  '## 阅读方式\n\n| 设备 | 展示方式 |\n| --- | --- |\n| 宽屏 | 会话与文档分屏 |\n| 手机 | 全屏阅读，返回会话 |\n\n' +
  '> 复制原文会保留标题、表格与代码的 Markdown 格式。\n\n' +
  '```ts\nconst preview = "read and discuss";\n```\n\n' +
  '[下一份文档](next.md)\n\n![示意图](./chart.png)\n\n' +
  Array.from(
    { length: 22 },
    (_, i) =>
      `## 实施步骤 ${i + 1}\n\n保留会话中的阅读位置。正文可以独立滚动，顶部始终可以返回和复制。`,
  ).join('\n\n') +
  '\n';

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/codex-markdown-preview-${name}.png`,
    animations: 'disabled',
  });
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await mkdir(join(thread.cwd, 'docs'), { recursive: true });
  await writeFile(join(thread.cwd, 'docs/实施 方案.md'), original);
  await writeFile(join(thread.cwd, 'docs/next.md'), '# 下一份文档\n\n相对路径已正确解析。');
  await writeFile(
    join(thread.cwd, 'docs/chart.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[markdown-files] 请整理一份实施方案');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

test('wide screens split chat and document; copy preserves the entire source and relative links work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const more = page.getByRole('button', { name: '更多操作', exact: true });
  await expect(more).toHaveCount(0);
  await fileLink(page).click();
  await expect(
    preview(page).getByRole('heading', { name: 'Markdown 文件预览', exact: true }),
  ).toBeVisible();
  await expect(more).toBeVisible();
  expect(await page.evaluate(() => innerWidth)).toBe(1600);
  await expect(preview(page).locator('table')).toContainText('会话与文档分屏');
  const panel = (await preview(page).boundingBox())!;
  const main = (await page.locator('.main-panel').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('边看文档边补充要求');
  await preview(page).getByRole('button', { name: '复制原文', exact: true }).click();
  await expect(preview(page).locator('.file-preview-feedback')).toHaveText('已复制 Markdown 原文');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  await screenshot(page, 'desktop');
  await preview(page).getByRole('button', { name: '原文', exact: true }).click();
  await expect(preview(page).getByLabel('Markdown 原文')).toHaveText(original);
  await preview(page).getByRole('button', { name: '预览', exact: true }).click();
  await expect(preview(page).locator('img')).toHaveJSProperty('naturalWidth', 1);
  await preview(page).getByRole('button', { name: '预览图片：示意图' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
  await preview(page).getByRole('link', { name: '下一份文档', exact: true }).click();
  await expect(preview(page).getByRole('heading', { name: '下一份文档' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0);
  await expect(more).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '边看文档边补充要求',
  );
  for (const name of ['绝对路径', '本地文件']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(preview(page).locator('table')).toBeVisible();
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  }
});

for (const width of [390, 320]) {
  test(`${width}px: full-screen reading, fixed controls, independent scrolling and return to the same conversation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await fileLink(page).click();
    await expect(preview(page).locator('table')).toBeVisible();
    expect(await preview(page).evaluate((node) => node.matches(':modal'))).toBe(true);
    const panel = (await preview(page).boundingBox())!;
    expect(panel.x).toBe(0);
    expect(panel.y).toBe(0);
    expect(panel.width).toBe(width);
    const chatPosition = await page
      .locator('.conversation-scroll')
      .evaluate((node) => node.scrollTop);
    const body = preview(page).getByLabel('文件内容', { exact: true });
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeInViewport();
    await expect(preview(page).getByRole('button', { name: '关闭文件预览' })).toBeInViewport();
    expect(await page.locator('.conversation-scroll').evaluate((node) => node.scrollTop)).toBe(
      chatPosition,
    );
    await body.evaluate((node) => {
      node.scrollTop = 0;
    });
    await preview(page).getByRole('button', { name: '复制原文' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
    await screenshot(page, `mobile-${width}`);
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
    await expect(preview(page)).toHaveCount(0);
    await expect(fileLink(page)).toBeFocused();
    expect(await page.locator('.conversation-scroll').evaluate((node) => node.scrollTop)).toBe(
      chatPosition,
    );
  });
}

test('missing files can be retried, loading can be cancelled and clipboard errors expose selectable source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '缺失文档', exact: true }).click();
  await expect(preview(page).getByRole('alert')).toContainText('不存在或已被删除');
  await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeDisabled();
  await screenshot(page, 'missing');
  await preview(page).getByRole('button', { name: '重新加载' }).click();
  await expect(preview(page).getByRole('alert')).toContainText('不存在或已被删除');
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  await page.route('**/markdown?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue().catch(() => {});
  });
  await fileLink(page).click();
  await expect(preview(page).getByText('正在加载文件…')).toBeVisible();
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  await page.unroute('**/markdown?**');
  await fileLink(page).click();
  await expect(preview(page).locator('table')).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
  );
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  await expect(preview(page).locator('.file-preview-feedback')).toContainText('复制失败');
  await expect(preview(page).getByLabel('Markdown 原文')).toBeVisible();
  await expect(preview(page).getByLabel('Markdown 原文')).toHaveText(original);
  await screenshot(page, 'clipboard-failure');
});

test('changing the selected thread releases the document and desktop can resize into a modal reader', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fileLink(page).click();
  await expect(preview(page).locator('table')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => preview(page).evaluate((node) => node.matches(':modal'))).toBe(true);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(() => preview(page).evaluate((node) => node.matches(':modal'))).toBe(false);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(preview(page)).toHaveCount(0);
});

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadView } from '../../src/shared/types';
import {
  diagramDocument,
  flowchart,
  invalidDiagram,
  sequence,
  themeDiagrams,
  themeDocument,
} from '../fixtures/mermaid';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  selectInterfaceLocale,
  openSidebarSettings,
} from './helpers';

const reply = (page: Page) => page.getByRole('article', { name: 'Codex 的回复' });
const blocks = (page: Page) => reply(page).locator('.mermaid-block');
const preview = (page: Page) =>
  page.getByRole('dialog', { name: 'Markdown 文件预览', exact: true });
const status = (page: Page) => page.locator('.turn-heading .status');
async function expectDiagram(block: Locator) {
  const image = block.getByRole('img', { name: 'Mermaid 图表', exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
}
async function writeDocument(page: Page, content: string) {
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const response = await page.request.get(`/api/threads/${id}`);
  const thread = (await response.json()) as ThreadView;
  await mkdir(join(thread.cwd, 'docs'), { recursive: true });
  await writeFile(join(thread.cwd, 'docs/mermaid.md'), content);
}

test.beforeEach(async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await controlRuntime(request, { reset: true });
  await page.emulateMedia({ colorScheme: 'light' });
  // Pin an explicit app preference when testing application-over-system precedence.
  await page.addInitScript(() => localStorage.setItem('covro.theme', 'light'));
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[mermaid] 展示任务流程与消息时序');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
});

test('streams without parsing partial fences; renders multiple diagrams, preserves source and recovers from errors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const first = blocks(page).first();
  await expect(first.getByRole('status')).toContainText('正在接收');
  await expect(first.getByLabel('Mermaid 源码')).toContainText('B{需要');
  await expect(first.getByRole('img')).toHaveCount(0);
  await expect(reply(page).getByRole('alert')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('/mermaid.core-')),
    ),
  ).toBe(false);
  await page.screenshot({ path: '/tmp/covro-mermaid-streaming.png', animations: 'disabled' });
  await expectDiagram(first);
  await expect(status(page)).toHaveText('执行中');
  const image = await first.getByRole('img').elementHandle();
  const sourceButton = first.getByRole('button', { name: '查看源码' });
  await sourceButton.focus();
  await expect(blocks(page).nth(1).getByRole('status')).toContainText('正在接收');
  await expect(status(page)).toHaveText('已完成');
  expect(await first.getByRole('img').evaluate((node, previous) => node === previous, image)).toBe(
    true,
  );
  await expect(sourceButton).toBeFocused();
  await expectDiagram(blocks(page).nth(1));
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(2).getByRole('alert')).toContainText('Mermaid 图表无法渲染');
  await expect(blocks(page).nth(2).getByLabel('Mermaid 源码')).toHaveText(invalidDiagram);
  await expect(reply(page)).toContainText('其他正文仍然可读');
  await expect(reply(page).locator('.markdown-code-block pre')).toHaveText(
    'flowchart LR\nA --> B\n',
  );
  await sourceButton.press('Enter');
  await expect(first.getByLabel('Mermaid 源码')).toHaveText(flowchart);
  await expect(first.getByRole('img')).toHaveCount(0);
  await first.getByRole('button', { name: '复制源码' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(flowchart);
  await first.screenshot({ path: '/tmp/covro-mermaid-source.png', animations: 'disabled' });
  await first.getByRole('button', { name: '查看图表' }).click();
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/covro-mermaid-reply.png', animations: 'disabled' });
  await blocks(page)
    .nth(2)
    .screenshot({ path: '/tmp/covro-mermaid-error.png', animations: 'disabled' });
  await page.reload();
  await expectDiagram(blocks(page).first());
  await expectDiagram(blocks(page).nth(1));
  await expect(blocks(page).nth(2).getByRole('alert')).toBeVisible();
});

test('Markdown preview reuses diagrams and keeps the complete document source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await expect(status(page)).toHaveText('已完成');
  await writeDocument(page, diagramDocument);
  await page.getByRole('link', { name: '阅读图表文档' }).click();
  const documentBlocks = preview(page).locator('.mermaid-block');
  await expectDiagram(documentBlocks.first());
  await expectDiagram(documentBlocks.nth(1));
  await documentBlocks.nth(1).getByRole('button', { name: '复制源码' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sequence);
  await documentBlocks.first().getByRole('button', { name: '查看源码' }).click();
  await expect(documentBlocks.first().getByLabel('Mermaid 源码')).toHaveText(flowchart);
  await page.screenshot({ path: '/tmp/covro-mermaid-preview.png', animations: 'disabled' });
  await preview(page).getByRole('button', { name: '复制原文', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(diagramDocument);
});

for (const width of [320, 390]) {
  test(`${width}px: wide diagrams scroll locally at actual size and work in mobile document previews`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await expect(status(page)).toHaveText('已完成');
    const block = blocks(page).nth(1);
    await expectDiagram(block);
    await block.getByRole('button', { name: '实际大小' }).click();
    const region = block.getByRole('region', { name: 'Mermaid 图表区域' });
    expect(await region.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    await region.focus();
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .locator('.conversation-scroll')
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(block.getByRole('button', { name: '复制源码' })).toBeInViewport();
    if (width === 390)
      await page.screenshot({ path: '/tmp/covro-mermaid-mobile.png', animations: 'disabled' });
    await block.getByRole('button', { name: '适应宽度' }).click();
    expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await writeDocument(page, diagramDocument);
    await page.getByRole('link', { name: '阅读图表文档' }).click();
    await expectDiagram(preview(page).locator('.mermaid-block').first());
    await preview(page)
      .locator('.mermaid-block')
      .first()
      .getByRole('button', { name: '查看源码' })
      .click();
    await expect(preview(page).getByLabel('Mermaid 源码')).toHaveText(flowchart);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('the application palette takes precedence over OS appearance and a denied clipboard reveals source', async ({
  page,
}) => {
  await expect(status(page)).toHaveText('已完成');
  const block = blocks(page).first();
  await expectDiagram(block);
  const lightSource = await block.getByRole('img').getAttribute('src');
  await page.emulateMedia({ colorScheme: 'dark' });
  // The explicit light app preference takes precedence over the OS dark appearance.
  await expect(block).toHaveAttribute('data-theme', 'light');
  await expectDiagram(block);
  await expect(block.getByRole('img')).toHaveAttribute('src', lightSource!);
  await block.screenshot({ path: '/tmp/covro-mermaid-os-dark.png', animations: 'disabled' });
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
  );
  await block.getByRole('button', { name: '复制源码' }).click();
  await expect(block.getByRole('status')).toContainText('复制失败');
  await expect(block.getByLabel('Mermaid 源码')).toHaveText(flowchart);
  await page.emulateMedia({ colorScheme: 'light' });
  await block.getByRole('button', { name: '查看图表' }).click();
  await expectDiagram(block);
  await expect(block).toHaveAttribute('data-theme', 'light');
  const settings = await openSidebarSettings(page);
  await settings.getByRole('combobox', { name: '外观', exact: true }).click();
  await page.getByRole('option', { name: '暗色', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(block).toHaveAttribute('data-theme', 'dark');
  await expectDiagram(block);
  await block.screenshot({ path: '/tmp/covro-mermaid-explicit-dark.png', animations: 'disabled' });
});

test('resolved application palette changes redraw both entries, including common Chinese diagrams (browser theme fixture)', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await expect(status(page)).toHaveText('已完成');
  const messageBlock = blocks(page).first();
  await expectDiagram(messageBlock);
  const lightSource = await messageBlock.getByRole('img').getAttribute('src');
  const svg = (source: string) => decodeURIComponent(source.slice(source.indexOf(',') + 1));
  const normalize = (source: string) => svg(source).replaceAll(/mermaid-\d+/g, 'mermaid-ID');
  expect(svg(lightSource!)).toContain('DM Sans');
  expect(svg(lightSource!)).toContain('#eaf4ef');
  expect(svg(lightSource!)).toContain('filter:none!important');
  await messageBlock.screenshot({ path: testInfo.outputPath('message-light.png') });

  await writeDocument(page, themeDocument);
  await page.getByRole('link', { name: '阅读图表文档' }).click();
  const documentBlocks = preview(page).locator('.mermaid-block');
  await expect(documentBlocks).toHaveCount(themeDiagrams.length);
  for (let i = 0; i < themeDiagrams.length; i++) {
    await documentBlocks.nth(i).scrollIntoViewIfNeeded();
    await expectDiagram(documentBlocks.nth(i));
    expect(svg((await documentBlocks.nth(i).getByRole('img').getAttribute('src'))!)).toMatch(
      /[\u4e00-\u9fff]/,
    );
    await documentBlocks.nth(i).screenshot({ path: testInfo.outputPath(`type-${i}-light.png`) });
  }
  expect(normalize((await documentBlocks.first().getByRole('img').getAttribute('src'))!)).toBe(
    normalize(lightSource!),
  );

  // Exercise a custom resolved palette independently of the built-in appearance selector.
  await page.addStyleTag({
    content: `:root.mermaid-test-dark {
      background: #20252b; color: #e2e8ee;
      --border: #46515b; --muted: #a5b0b9; --sidebar: #252c33;
      --accent: #8ac9ae; --accent-soft: #2e443b; --destructive: #ffb5af;
    }`,
  });
  await page.evaluate(() => document.documentElement.classList.add('mermaid-test-dark'));
  for (let i = 0; i < themeDiagrams.length; i++) {
    const block = documentBlocks.nth(i);
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute('data-theme', 'dark');
    await expectDiagram(block);
    await expect(block).toHaveCSS('background-color', 'rgb(32, 37, 43)');
    expect(svg((await block.getByRole('img').getAttribute('src'))!)).toContain('#e2e8ee');
    await block.screenshot({ path: testInfo.outputPath(`type-${i}-dark.png`) });
  }
  await expect(messageBlock).toHaveAttribute('data-theme', 'dark');
  const darkSource = await messageBlock.getByRole('img').getAttribute('src');
  expect(normalize((await documentBlocks.first().getByRole('img').getAttribute('src'))!)).toBe(
    normalize(darkSource!),
  );

  const sequenceBlock = documentBlocks.nth(1);
  await sequenceBlock.getByRole('button', { name: '实际大小' }).click();
  await documentBlocks.first().getByRole('button', { name: '查看源码' }).click();
  // The OS changes while the explicit application palette stays dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(sequenceBlock).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => document.documentElement.classList.remove('mermaid-test-dark'));
  await expect(sequenceBlock).toHaveAttribute('data-theme', 'light');
  await expectDiagram(sequenceBlock);
  await expect(sequenceBlock.getByRole('button', { name: '适应宽度' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(documentBlocks.first().getByLabel('Mermaid 源码')).toHaveText(flowchart);
  await documentBlocks.first().getByRole('button', { name: '查看图表' }).click();
  await expectDiagram(documentBlocks.first());
  expect(normalize((await documentBlocks.first().getByRole('img').getAttribute('src'))!)).toBe(
    normalize(lightSource!),
  );
  // Inline root palette changes also update diagrams, without any OS change.
  await page.evaluate(() => document.documentElement.style.setProperty('--accent-soft', '#e0eee7'));
  await expect
    .poll(async () =>
      svg((await documentBlocks.first().getByRole('img').getAttribute('src')) ?? ''),
    )
    .toContain('#e0eee7');
});

for (const locale of ['zh-Hans', 'en', 'ja', 'ko']) {
  test(`${locale}: desktop and narrow Mermaid toolbars and previews retain their controls`, async ({
    page,
  }, testInfo) => {
    await expect(status(page)).toHaveText('已完成');
    await writeDocument(page, diagramDocument);
    await selectInterfaceLocale(page, locale);
    // Use shared structural selectors so the same behavior is checked in every locale.
    const messageBlock = page.locator('.assistant-message .mermaid-block').first();
    await page.setViewportSize({ width: 1280, height: 900 });
    await messageBlock.scrollIntoViewIfNeeded();
    await messageBlock.screenshot({ path: testInfo.outputPath(`${locale}-desktop-message.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await messageBlock.scrollIntoViewIfNeeded();
    await expect(messageBlock.getByRole('img')).toBeVisible();
    for (const button of await messageBlock.getByRole('button').all()) {
      await expect(button).toBeInViewport();
    }
    await messageBlock.screenshot({ path: testInfo.outputPath(`${locale}-message.png`) });
    await page.getByRole('link', { name: '阅读图表文档' }).click();
    const dialog = page.locator('dialog.file-preview');
    const documentBlock = dialog.locator('.mermaid-block').first();
    await expect(documentBlock.getByRole('img')).toBeVisible();
    await documentBlock.getByRole('button').first().click();
    await expect(documentBlock.locator('.mermaid-source')).toHaveText(flowchart);
    await documentBlock.getByRole('button').first().click();
    for (const button of await documentBlock.getByRole('button').all()) {
      await expect(button).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`${locale}-preview.png`) });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(documentBlock.getByRole('img')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${locale}-desktop-preview.png`) });
  });
}

test('diagram directives cannot enable scripts or inject page CSS; failed diagrams do not poison the rendering queue', async ({
  page,
}) => {
  await expect(status(page)).toHaveText('已完成');
  const unsafe = `---\nconfig:\n  securityLevel: loose\n  themeCSS: 'body { background: rgb(255, 0, 0) !important; }'\n---\nflowchart LR\n  A["<img src=x onerror=window.mermaidInjected=true>"] --> B[安全]\n  click A call mermaidInjected()\n`;
  await writeDocument(
    page,
    `# 安全与失败回退\n\n\`\`\`mermaid\n${unsafe}\`\`\`\n\n\`\`\`mermaid\n${invalidDiagram}\`\`\`\n\n\`\`\`mermaid\n${sequence}\`\`\``,
  );
  const background = await page
    .locator('body')
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.getByRole('link', { name: '阅读图表文档' }).click();
  const documentBlocks = preview(page).locator('.mermaid-block');
  await expectDiagram(documentBlocks.first());
  await expect(documentBlocks.nth(1).getByRole('alert')).toBeVisible();
  await expectDiagram(documentBlocks.nth(2));
  const svg = await documentBlocks.first().getByRole('img').getAttribute('src');
  expect(decodeURIComponent(svg!)).not.toContain('background: rgb(255, 0, 0)');
  expect(await page.evaluate(() => Reflect.get(window, 'mermaidInjected'))).toBeUndefined();
  expect(
    await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe(background);
  await expect(page.locator('body > div[aria-hidden="true"]')).toHaveCount(0);
  await expect(documentBlocks.locator('svg, script')).toHaveCount(0);
});

test('an interrupted partial fence leaves the waiting state and exposes the rendering error', async ({
  page,
}) => {
  const block = blocks(page).first();
  await expect(block.getByRole('status')).toContainText('正在接收');
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(status(page)).toHaveText('已中断');
  await expect(block.getByRole('alert')).toContainText('Mermaid 图表无法渲染');
  await expect(block.getByLabel('Mermaid 源码')).toContainText('A[收到任务]');
  await page.reload();
  await expect(blocks(page).first().getByRole('alert')).toBeVisible();
});

test('nested and alternate fences render; oversized source falls back without blocking later diagrams', async ({
  page,
}) => {
  await expect(status(page)).toHaveText('已完成');
  const oversized = 'flowchart LR\n%% ' + 'x'.repeat(50_000);
  const nested = '> ~~~~MERMAID\n> flowchart LR\n> A --> B\n> ~~~~~';
  await writeDocument(
    page,
    `${nested}\n\n\`\`\`mermaid\n${oversized}\n\`\`\`\n\n\`\`\`mermaid\n${sequence}`,
  );
  await page.getByRole('link', { name: '阅读图表文档' }).click();
  const documentBlocks = preview(page).locator('.mermaid-block');
  await expectDiagram(documentBlocks.first());
  await expect(documentBlocks.nth(1).getByRole('alert')).toBeVisible();
  await expect(documentBlocks.nth(1).getByLabel('Mermaid 源码')).toHaveText(oversized + '\n');
  await expectDiagram(documentBlocks.nth(2));
});

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlRuntime, openSidebarSettings, selectInterfaceLocale } from './helpers';

async function ready(page: import('@playwright/test').Page) {
  await expect(page.locator('.compatibility-dialog[open]')).toBeVisible();
  await page.locator('.compatibility-dialog-actions button').last().click();
  await expect(page.locator('.compatibility-dialog[open]')).toHaveCount(0);
}

const evidence = join(tmpdir(), 'covro-i18n-evidence');
const languages = [
  {
    locale: 'zh-Hans',
    browser: 'zh-CN',
    label: '语言',
    title: '额外权限审批',
    allow: '当前任务允许',
    model: '模型',
    modelSettings: '模型设置',
  },
  {
    locale: 'en',
    browser: 'en-US',
    label: 'Language',
    title: 'Additional permissions',
    allow: 'Allow for current task',
    model: 'Model',
    modelSettings: 'Model settings',
  },
  {
    locale: 'ja',
    browser: 'ja-JP',
    label: '言語',
    title: '追加権限の承認',
    allow: '現在のタスクで許可',
    model: 'モデル',
    modelSettings: 'モデル設定',
  },
  {
    locale: 'ko',
    browser: 'ko-KR',
    label: '언어',
    title: '추가 권한 승인',
    allow: '현재 작업에서 허용',
    model: '모델',
    modelSettings: '모델 설정',
  },
] as const;

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
for (const language of languages) {
  test.describe(language.locale, () => {
    test.use({ locale: language.browser, viewport: { width: 1440, height: 1100 } });
    test('approval, language selector, narrow layout and original text', async ({
      page,
      request,
    }) => {
      await controlRuntime(request, { reset: true, version: '0.163.0' });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
      await ready(page);
      const settings = await openSidebarSettings(page);
      const selector = settings.locator('.language-selector [role="combobox"]');
      await expect(selector).toHaveAttribute('data-value', language.locale);
      await selector.click();
      await expect(page.getByRole('option')).toHaveText([
        '简体中文',
        'English',
        '日本語',
        '한국어',
      ]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: language.modelSettings, exact: true }).click();
      await expect(page.getByRole('combobox', { name: language.model, exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      const prompt = '[permissions] 原文保留 Japanese 日本語 한국어 /workspace/example.ts';
      const input = page.locator('.composer-box textarea');
      await input.fill(prompt);
      await input.press('Enter');
      await expect(page.locator('.action-card h3')).toHaveText(language.title);
      await expect(page.locator('.user-message')).toContainText(prompt);
      await expect(page.locator('.permission-paths')).toContainText('/screenshots');
      await page.screenshot({
        path: `${evidence}/${language.locale}-desktop.png`,
        fullPage: true,
        animations: 'disabled',
      });
      // Changing the interface must neither remount the composer nor send/approve a task.
      await input.fill('未发送的草稿 draft 日本語 한국어');
      const threadId = await page.evaluate(() =>
        localStorage.getItem('codex-web.selected:fixture'),
      );
      const before = await (await request.get(`/api/threads/${threadId}`)).json();
      await selectInterfaceLocale(page, 'en');
      await expect(input).toHaveValue('未发送的草稿 draft 日本語 한국어');
      await selectInterfaceLocale(page, language.locale);
      const after = await (await request.get(`/api/threads/${threadId}`)).json();
      expect(after.turns.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual(
        before.turns.map((t: { id: string; status: string }) => [t.id, t.status]),
      );
      expect(
        after.actions.map((a: { actionId: string; status: string }) => [a.actionId, a.status]),
      ).toEqual(
        before.actions.map((a: { actionId: string; status: string }) => [a.actionId, a.status]),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.action-card h3')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `${evidence}/${language.locale}-mobile.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.locator('.topbar .mobile-only').click();
      await openSidebarSettings(page);
      await expect(page.locator('.language-selector [role="combobox"]')).toBeVisible();
      await page.screenshot({
        path: `${evidence}/${language.locale}-mobile-selector.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await page.locator('.sidebar-open .brand .mobile-only').click();
      const resolution = page.waitForRequest(
        (request) =>
          /\/api\/actions\/[^/]+\/resolve$/.test(request.url()) && request.method() === 'POST',
      );
      await page
        .locator('.action-card')
        .getByRole('button', { name: language.allow, exact: true })
        .click();
      expect((await resolution).postDataJSON().resolution.decision).toBe('accept');
      await expect(page.locator('.action-card')).toHaveCount(0);
      await expect(page.locator('.turn-heading .status').last()).toHaveText(
        { 'zh-Hans': '已完成', en: 'Completed', ja: '完了', ko: '완료' }[language.locale],
      );
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.locator('.settings-policy').click();
      await expect(page.locator('[data-slot="select-content"]')).toBeVisible();
      await page.screenshot({
        path: `${evidence}/${language.locale}-menu.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      const projects = (await (await request.get('/api/projects')).json()) as {
        data: { id: string; rootPath: string }[];
      };
      const root = projects.data.find((project) => project.id === 'fixture')!.rootPath;
      expect(root).toContain('codex-web-e2e-');
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(
        join(root, 'docs', '项目 配置.JSON'),
        JSON.stringify(
          { project: '原文保持不变', languages: ['zh-Hans', 'en', 'ja', 'ko'], count: 1234 },
          null,
          2,
        ),
      );
      await input.fill('[json-files] 保留 JSON 原文');
      await input.press('Enter');
      await page.getByRole('link', { name: '配置文件', exact: true }).click();
      await expect(page.locator('.file-preview[open]')).toBeVisible();
      await expect(page.locator('.file-preview .json-preview')).toContainText('原文保持不变');
      await expect(page.locator('.turn-heading .status').last()).toHaveText(
        { 'zh-Hans': '已完成', en: 'Completed', ja: '完了', ko: '완료' }[language.locale],
      );
      const peer = await page.context().newPage();
      await peer.goto('/');
      await selectInterfaceLocale(peer, 'en');
      await expect(page.locator('.file-preview[open]')).toBeVisible();
      await selectInterfaceLocale(peer, language.locale);
      await peer.close();
      expect((await page.locator('.topbar-title').boundingBox())!.width).toBeGreaterThan(150);
      expect((await page.locator('.breadcrumb').boundingBox())!.height).toBeLessThan(25);
      await page.screenshot({
        path: `${evidence}/${language.locale}-preview.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.locator('.file-preview-header button').first().click();
      const turns = await page.locator('.turn').count();
      await input.fill('[diff-preview] 原文保留');
      await input.press('Enter');
      await expect(page.locator('.turn')).toHaveCount(turns + 1);
      await expect(page.locator('.turn-heading .status').last()).toHaveText(
        { 'zh-Hans': '已完成', en: 'Completed', ja: '完了', ko: '완료' }[language.locale],
      );
      await page.locator('.turn-diff').last().click();
      await expect(page.locator('.file-preview .diff-file')).toHaveCount(5);
      await expect(page.locator('.file-preview')).not.toContainText('covro-message:');
      await expect(page.locator('.file-preview')).toContainText('src/预览 workspace.ts');
      await page.screenshot({
        path: `${evidence}/${language.locale}-diff.png`,
        animations: 'disabled',
      });
      await page.locator('.file-preview-header button').first().click();
      await input.fill('[mermaid] 保留图表源码');
      await input.press('Enter');
      await expect(page.locator('.turn')).toHaveCount(turns + 2);
      const diagram = page.locator('.mermaid-diagram img').first();
      await expect(diagram).toBeVisible();
      await expect
        .poll(() => diagram.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      await expect(page.locator('.turn-heading .status').last()).toHaveText(
        { 'zh-Hans': '已完成', en: 'Completed', ja: '完了', ko: '완료' }[language.locale],
      );
      await page.locator('.mermaid-block').first().scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/${language.locale}-mermaid.png`,
        animations: 'disabled',
      });
    });
  });
}

test('manual choice overrides browser preferences after reload and in another tab', async ({
  page,
  context,
  request,
}) => {
  await controlRuntime(request, { reset: true, version: '0.163.0' });
  await page.goto('/');
  await ready(page);
  await selectInterfaceLocale(page, 'ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('lang', 'ko');
  await selectInterfaceLocale(other, 'ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

for (const browserLocale of ['zh-TW', 'zh-HK', 'fr-FR']) {
  test.describe(`unsupported ${browserLocale}`, () => {
    test.use({ locale: browserLocale });
    test('falls back to English', async ({ page, request }) => {
      await controlRuntime(request, { reset: true, version: '0.163.0' });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await ready(page);
      await openSidebarSettings(page);
      await expect(page.locator('.language-selector [role="combobox"]')).toHaveAttribute(
        'data-value',
        'en',
      );
    });
  });
}

test('the workspace remains usable when browser storage is blocked', async ({ page, request }) => {
  await controlRuntime(request, { reset: true, version: '0.163.0' });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await page.goto('/');
  await ready(page);
  await selectInterfaceLocale(page, 'ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('.composer-box textarea')).toBeVisible();
});

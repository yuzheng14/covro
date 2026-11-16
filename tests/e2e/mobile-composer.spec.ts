import { devices, expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

const input = (page: Page) => page.locator('.composer-box textarea');
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const hint = '点击发送按钮 · Enter 换行';
async function flush(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const device of [
  { name: 'iPhone portrait', ...devices['iPhone 13'] },
  { name: 'Android landscape', ...devices['Pixel 7 landscape'] },
  {
    name: 'iPad desktop UA',
    ...devices['iPad Pro 11'],
    userAgent: devices['Desktop Safari'].userAgent,
    platform: 'MacIntel',
  },
]) {
  test.describe(device.name, () => {
    test.use({
      userAgent: device.userAgent,
      viewport: device.viewport,
      isMobile: true,
      hasTouch: true,
    });

    test('newlines, native paste and IME edits preserve first and existing drafts until button submission', async ({
      page,
      context,
    }, testInfo) => {
      if ('platform' in device)
        await page.addInitScript(() =>
          Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }),
        );
      await page.goto('/');
      await confirmCompatibility(page);
      await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
      const writes: { path: string; text?: string }[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/api\/(projects\/[^/]+\/threads|threads\/[^/]+\/(turns|steer))$/.test(
            new URL(request.url()).pathname,
          )
        )
          writes.push({ path: new URL(request.url()).pathname, text: request.postDataJSON().text });
      });
      await expect(input(page)).toHaveAttribute('enterkeyhint', 'enter');
      await expect(send(page)).toHaveAccessibleDescription(hint);
      await expect(page.locator('.composer-input-hint')).toHaveText(hint);
      await input(page).fill('第一行');
      await input(page).press('Enter');
      await input(page).press('Enter');
      await expect(input(page)).toHaveValue('第一行\n\n');
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const pasted = '    保留缩进\n\t中文内容\n';
      await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
      await input(page).press('ControlOrMeta+V');
      const draft = `第一行\n\n${pasted}`;
      await expect(input(page)).toHaveValue(draft);
      await input(page).dispatchEvent('compositionstart');
      await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await send(page).click();
      // Also cover engines that end composition immediately before confirming Enter.
      await input(page).evaluate((element) => {
        element.dispatchEvent(
          new CompositionEvent('compositionend', { bubbles: true, data: '中文' }),
        );
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      });
      await input(page).press('Enter');
      await input(page).pressSequentially('继续编辑');
      const finalDraft = `${draft}\n继续编辑`;
      await expect(input(page)).toHaveValue(finalDraft);
      await flush(page);
      expect(writes).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath('mobile-multiline.png'), fullPage: true });
      await send(page).click();
      await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
      expect(writes).toHaveLength(2);
      expect(writes[1]!.text).toBe(finalDraft);
      await input(page).fill('[approval] 已有会话');
      await input(page).press('Enter');
      await flush(page);
      expect(writes).toHaveLength(2);
      await send(page).click();
      await expect(page.locator('.action-card')).toBeVisible();
      await input(page).fill('追加第一行');
      await input(page).press('Enter');
      await input(page).pressSequentially('追加第二行');
      await flush(page);
      expect(writes).toHaveLength(3);
      const steer = page.getByRole('button', { name: '追加要求', exact: true });
      await expect(steer).toHaveAccessibleDescription(hint);
      await steer.click();
      await expect(input(page)).toHaveValue('');
      expect(writes).toHaveLength(4);
      expect(writes[3]).toMatchObject({ text: '追加第一行\n追加第二行' });
      expect(writes[3]!.path).toMatch(/\/steer$/);
      // Slash drafts use the same policy, including the menu's guidance.
      await input(page).fill('/help');
      await input(page).press('Enter');
      await expect(input(page)).toHaveValue('/help\n');
      await expect(page.locator('.slash-menu-footer')).toHaveText('点击执行命令 · Enter 换行');
      await expect(page.locator('.slash-feedback')).toHaveCount(0);
      await page.getByRole('button', { name: '执行命令', exact: true }).click();
      await expect(page.locator('.slash-feedback')).toBeVisible();
      await expect(input(page)).toHaveValue('');
      expect(writes).toHaveLength(4);
    });
  });
}

test.describe('mobile keyboard viewport', () => {
  test.use({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test('send stays visible when the visual viewport shrinks and pans; blur and pinch zoom restore layout', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await input(page).fill('键盘展开时\n也能点击发送');
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: 390 },
        offsetTop: { configurable: true, value: 45 },
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '390px');
    await expect(page.locator('.app-shell')).toHaveCSS('top', '45px');
    const button = await send(page).boundingBox();
    expect(button!.y).toBeGreaterThanOrEqual(45);
    expect(button!.y + button!.height).toBeLessThanOrEqual(435);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    expect(button!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('mobile-viewport.png'), fullPage: true });
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 240 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '240px');
    await expect
      .poll(async () => {
        const bounds = (await send(page).boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeLessThanOrEqual(285);
    await expect(send(page)).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath('mobile-viewport-short.png'),
      fullPage: true,
    });
    await input(page).evaluate((element) => element.blur());
    await expect(page.locator('.app-shell')).toHaveCSS('height', '844px');
    await input(page).focus();
    await expect(page.locator('.app-shell')).toHaveCSS('height', '240px');
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 2 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '844px');
  });
});

test.describe('touch desktop at phone width', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
    hasTouch: true,
  });
  test('keeps desktop Enter and Shift+Enter behavior', async ({ page }, testInfo) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await expect(send(page)).toHaveAccessibleDescription('Enter 发送 / Shift + Enter 换行');
    await input(page).fill('桌面窄窗口');
    await input(page).press('Shift+Enter');
    await input(page).pressSequentially('触屏电脑');
    await expect(input(page)).toHaveValue('桌面窄窗口\n触屏电脑');
    await send(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Enter 发送 / Shift + Enter 换行');
    await page.screenshot({ path: testInfo.outputPath('desktop-shortcut.png'), fullPage: true });
    await input(page).press('Enter');
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  });
});

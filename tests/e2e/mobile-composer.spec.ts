import { devices, expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, openModelSettings } from './helpers';

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

// Simulate viewport data from an on-screen keyboard. Playwright does not open a native IME.
async function setVisualViewport(
  page: Page,
  geometry: Partial<Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>>,
) {
  await page.evaluate((geometry) => {
    const viewport = window.visualViewport!;
    for (const key of ['height', 'offsetTop', 'scale'] as const) {
      const value = geometry[key];
      if (value === undefined) Reflect.deleteProperty(viewport, key);
      else Object.defineProperty(viewport, key, { configurable: true, value });
    }
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
  }, geometry);
  await flush(page);
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
  test('interrupt and send have equal outlines and separate touch targets', async ({ page }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    const submit = page.locator('.composer-submit > button');
    const interrupt = page.getByRole('button', { name: '中断', exact: true });
    await input(page).fill('[approval] 验证触控目标');
    const idle = await submit.boundingBox();
    await submit.tap();
    await expect(page.locator('.action-card')).toBeVisible();
    await expect(interrupt).toBeEnabled();
    await expect(submit).toBeDisabled();
    expect(await submit.boundingBox()).toEqual(idle);

    await input(page).fill('保留这份草稿');
    await expect(submit).toBeEnabled();
    expect(await submit.boundingBox()).toEqual(idle);
    expect(await interrupt.boundingBox()).toMatchObject({
      width: idle!.width,
      height: idle!.height,
      y: idle!.y,
    });

    for (const action of [interrupt, submit]) {
      expect(
        await action.evaluate((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          const xs = [x + width / 2 - 21, x + width / 2 + 21];
          const ys = [y + height / 2 - 21, y + height / 2 + 21];
          return xs.every((px) => ys.every((py) => document.elementFromPoint(px, py) === button));
        }),
      ).toBe(true);
    }

    await interrupt.tap();
    await expect(interrupt).toHaveCount(0);
    expect(await submit.boundingBox()).toEqual(idle);
    await expect(input(page)).toHaveValue('保留这份草稿');
  });

  test('composer follows a shrunken, panning viewport and restores the bottom safe area on close', async ({
    page,
    context,
  }, testInfo) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
    await page.goto('/');
    await confirmCompatibility(page);
    const shell = page.locator('.app-shell');
    const composer = page.locator('.composer-box');
    const region = page.locator('.composer-region');
    const draft = '键盘展开时\n也能点击发送';
    await input(page).fill(draft);
    await input(page).evaluate((element) =>
      (element as HTMLTextAreaElement).setSelectionRange(2, 5),
    );
    await expect(shell).not.toHaveAttribute('data-mobile-input-viewport');
    await expect(region).toHaveCSS('padding-bottom', '34px');

    // A layout viewport scroll and a visual viewport pan are separate coordinates.
    await page.evaluate(() => {
      document.body.style.minHeight = '1100px';
      window.scrollTo(0, 72);
    });
    await setVisualViewport(page, { height: 390, offsetTop: 45 });
    expect(await page.evaluate(() => scrollY)).toBe(72);
    await expect(shell).toHaveCSS('height', '390px');
    await expect(page.locator('.topbar[data-compact]')).toHaveCSS('flex-shrink', '1');
    const bounds = (await composer.boundingBox())!;
    expect(435 - bounds.y - bounds.height).toBeCloseTo(12, 0);
    const touchTarget = (await page.locator('.composer-submit').boundingBox())!;
    expect(touchTarget.y).toBeGreaterThanOrEqual(45);
    expect(touchTarget.y + touchTarget.height).toBeLessThanOrEqual(435);
    expect(touchTarget.width).toBeGreaterThanOrEqual(44);
    expect(touchTarget.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('mobile-viewport.png'), fullPage: true });

    // Blur can arrive before the keyboard has finished closing.
    await input(page).evaluate((element) => element.blur());
    await flush(page);
    await expect(shell).toHaveCSS('height', '390px');
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.body.style.removeProperty('min-height');
    });
    await setVisualViewport(page, {});
    await expect(shell).toHaveCSS('height', '844px');
    await expect(region).toHaveCSS('padding-bottom', '34px');
    await expect(shell).not.toHaveAttribute('data-mobile-input-viewport');
    await expect(input(page)).toHaveJSProperty('selectionStart', 2);
    await expect(input(page)).toHaveJSProperty('selectionEnd', 5);
    await expect(input(page)).toHaveValue(draft);

    await input(page).focus();
    // A viewport change smaller than the safe area preserves the remaining inset.
    await setVisualViewport(page, { height: 830 });
    await expect(region).toHaveCSS('padding-bottom', '20px');
    await setVisualViewport(page, {});
    await expect(region).toHaveCSS('padding-bottom', '34px');
    await expect(input(page)).toBeFocused();

    await setVisualViewport(page, { height: 390, offsetTop: 45 });
    await setVisualViewport(page, { height: 390, offsetTop: 30, scale: 2 });
    await expect(shell).toHaveCSS('height', '844px');
    await expect(region).toHaveCSS('padding-bottom', '34px');

    await page.setViewportSize({ width: 844, height: 390 });
    await setVisualViewport(page, { height: 320, offsetTop: 30 });
    await expect(send(page)).toBeInViewport({ ratio: 1 });
    await expect(input(page)).toBeInViewport({ ratio: 1 });
    await setVisualViewport(page, { height: 240, offsetTop: 30 });
    await expect(shell).toHaveCSS('height', '240px');
    await expect(send(page)).toBeInViewport({ ratio: 1 });
    const landscapeButton = (await send(page).boundingBox())!;
    expect(landscapeButton.y + landscapeButton.height).toBeLessThanOrEqual(270);
    // The fixture displays two banners. At this height the editor and action row share a scroller.
    await page.locator('.bottom-region').evaluate((element) => (element.scrollTop = 0));
    await expect(input(page)).toBeInViewport({ ratio: 0.95 });
    await page.screenshot({ path: testInfo.outputPath('mobile-viewport-short.png') });
    await setVisualViewport(page, {});
    await expect(shell).toHaveCSS('height', '390px');
    await expect(send(page)).toBeInViewport({ ratio: 1 });
    await expect(input(page)).toHaveValue(draft);
  });

  test('opening and closing the composer viewport preserves the reading position and model menu', async ({
    page,
  }) => {
    await page.goto('/');
    await confirmCompatibility(page);
    await input(page).fill('[sticky-prompt] 保持长回复的阅读位置');
    await send(page).tap();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    const conversation = page.locator('.conversation-scroll');
    const readPosition = await conversation.evaluate((element) => {
      element.scrollTop = 200;
      return element.scrollTop;
    });
    expect(readPosition).toBe(200);
    await input(page).fill('保留这份草稿');
    await setVisualViewport(page, { height: 390, offsetTop: 45 });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '390px');
    await expect(conversation).toHaveJSProperty('scrollTop', readPosition);
    await openModelSettings(page);
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeInViewport();
    await page.keyboard.press('Escape');
    await setVisualViewport(page, {});
    await expect(conversation).toHaveJSProperty('scrollTop', readPosition);
    await expect(input(page)).toHaveValue('保留这份草稿');
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

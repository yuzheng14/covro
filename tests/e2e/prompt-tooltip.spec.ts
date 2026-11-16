import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createEmptyThread } from './helpers';

const sticky = (page: Page) => page.locator('.sticky-prompt');
const hint = (page: Page) => page.getByRole('tooltip');
const prompt = (page: Page) => page.locator('.conversation-content .user-message').first();
const scroll = (page: Page) => page.locator('.conversation-scroll');
const error = (page: Page) => page.locator('.error-banner.dismissible');
const labels = {
  'zh-Hans': '回到 Prompt 原文',
  en: 'Back to original prompt',
  ja: '元のプロンプトへ',
  ko: '원래 프롬프트로 이동',
};

async function start(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  const navigation = page.locator('.topbar .mobile-only');
  if (await navigation.isVisible()) await navigation.click();
  await createEmptyThread(page);
  await page
    .locator('.composer-box textarea')
    .fill('[sticky-prompt] Check prompt tooltip positioning.');
  await page.locator('.composer-submit button').click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await scroll(page).evaluate((element) => (element.scrollTop = 300));
  await expect(sticky(page)).toBeVisible();
}

async function expectAttached(page: Page, side: 'top' | 'bottom' = 'bottom') {
  await expect(hint(page)).toBeVisible();
  await expect(hint(page)).toHaveAttribute('data-side', side);
  const arrow = hint(page).locator('.tooltip-arrow');
  await expect(arrow).toBeVisible();
  await expect(async () => {
    // Read all geometry in one frame: async title/font and banner layout can otherwise
    // move the trigger between separate boundingBox calls.
    const geometry = await hint(page).evaluate((element) => {
      const arrow = element.querySelector('.tooltip-arrow')!;
      return {
        trigger: document.querySelector('.sticky-prompt')!.getBoundingClientRect().toJSON(),
        content: element.getBoundingClientRect().toJSON(),
        arrow: arrow.getBoundingClientRect().toJSON(),
        fill: getComputedStyle(arrow).fill,
        background: getComputedStyle(element).backgroundColor,
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    const { trigger: triggerBox, content: contentBox, arrow: arrowBox } = geometry;
    expect(
      Math.abs(arrowBox.x + arrowBox.width / 2 - (triggerBox.x + triggerBox.width / 2)),
    ).toBeLessThan(2);
    if (side === 'bottom') {
      expect(contentBox.y).toBeGreaterThan(triggerBox.y + triggerBox.height);
      expect(Math.abs(contentBox.y - (arrowBox.y + arrowBox.height))).toBeLessThan(1);
    } else {
      expect(contentBox.y + contentBox.height).toBeLessThan(triggerBox.y);
      expect(Math.abs(contentBox.y + contentBox.height - arrowBox.y)).toBeLessThan(1);
    }
    expect(contentBox.x).toBeGreaterThanOrEqual(8);
    expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(geometry.width - 8);
    expect(contentBox.y).toBeGreaterThanOrEqual(8);
    expect(contentBox.y + contentBox.height).toBeLessThanOrEqual(geometry.height - 8);
    expect(geometry.fill).toBe(geometry.background);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
  }).toPass({ timeout: 5000 });
}

async function timeoutOnNextSend(page: Page) {
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_RPC_ERROR', message: 'signal timed out' } },
    }),
  );
  await page.locator('.composer-box textarea').fill('Check timeout layout');
  await page.locator('.composer-submit button').click();
  await expect(error(page)).toContainText('signal timed out');
  await error(page).locator('.error-technical summary').click();
}

async function capture(page: Page, path: string) {
  await page.screenshot({ path, animations: 'disabled' });
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

// The application currently has a fixed light palette; dark here is the OS color preference.
for (const [locale, widths] of Object.entries({
  'zh-Hans': [1280, 390],
  en: [390, 1280],
  ja: [1280, 320],
  ko: [320, 1280],
})) {
  for (const [index, width] of widths.entries()) {
    const colorScheme = index === 0 ? 'light' : 'dark';
    test(`${locale} ${colorScheme} ${width}px keeps normal and timeout hints attached`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      // Keep setup language stable, then load the chosen existing translation.
      await start(page);
      await page.evaluate((value) => localStorage.setItem('covro.locale', value), locale);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await scroll(page).evaluate((element) => (element.scrollTop = 300));
      await sticky(page).hover();
      await expect(hint(page)).toHaveText(labels[locale as keyof typeof labels]);
      await expectAttached(page);
      await capture(page, testInfo.outputPath('normal.png'));

      await timeoutOnNextSend(page);
      await sticky(page).hover();
      await expectAttached(page);
      const bannerBox = (await error(page).boundingBox())!;
      const triggerBox = (await sticky(page).boundingBox())!;
      expect(triggerBox.y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height);
      await capture(page, testInfo.outputPath('timeout.png'));
      await error(page).locator('button').click();
      await expect(error(page)).toHaveCount(0);
      await sticky(page).hover();
      await expectAttached(page);
    });
  }
}

test('tracks an error arriving during hover, scrolling, pinning and keyboard navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await start(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/threads/*/turns', async (route) => {
    await gate;
    await route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_RPC_ERROR', message: 'signal timed out' } },
    });
  });
  await page.locator('.composer-box textarea').fill('Wait for timeout');
  await page.locator('.composer-submit button').click();
  await sticky(page).hover();
  await expectAttached(page);
  release();
  await expect(error(page)).toContainText('signal timed out');
  // Moving banners must reposition an already-open hint without another hover.
  await expect
    .poll(async () => {
      const button = (await sticky(page).boundingBox())!;
      const tooltip = (await hint(page).boundingBox())!;
      return tooltip.y - button.y - button.height;
    })
    .toBeCloseTo(13, 0);
  await expectAttached(page);
  await error(page)
    .locator('button')
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(error(page)).toHaveCount(0);
  await expectAttached(page);
  await scroll(page).evaluate((element) => (element.scrollTop += 120));
  await expectAttached(page);
  await scroll(page).evaluate((element) => (element.scrollTop = 0));
  await expect(sticky(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
  await scroll(page).evaluate((element) => (element.scrollTop = 300));
  await expect(sticky(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await sticky(page).focus();
  await expectAttached(page);
  await page.keyboard.press('Escape');
  await expect(hint(page)).toHaveCount(0);
  await sticky(page).press('Enter');
  await expect(prompt(page)).toBeFocused();
  await expect(sticky(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
});

test('flips at the viewport bottom and shifts at either horizontal edge with a visible arrow', async ({
  page,
}) => {
  await start(page);
  // Geometry-only fixture: exercise Radix collision handling on the real Prompt trigger.
  const slot = page.locator('.sticky-prompt-slot');
  await slot.evaluate((element: HTMLElement) => {
    Object.assign(element.style, {
      position: 'fixed',
      top: 'auto',
      bottom: '45px',
      width: '200px',
      margin: '0',
      padding: '0',
      left: '0',
      right: 'auto',
    });
  });
  await sticky(page).hover();
  await expectAttached(page, 'top');
  await slot.evaluate((element: HTMLElement) =>
    Object.assign(element.style, { left: 'auto', right: '0' }),
  );
  await expectAttached(page, 'top');
  await slot.evaluate((element: HTMLElement) => element.removeAttribute('style'));
  await sticky(page).hover();
  await expectAttached(page);
});

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('jumps to the original prompt with one tap without leaving a hint', async ({ page }) => {
    await start(page);
    await sticky(page).tap();
    await expect(prompt(page)).toBeFocused();
    await expect(sticky(page)).toHaveCount(0);
    await expect(hint(page)).toHaveCount(0);
  });
});

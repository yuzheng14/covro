import { devices, expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

const input = (page: Page) => page.locator('.composer-editor textarea');

async function selectSkill(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('$review');
  await page
    .getByRole('listbox', { name: '技能', exact: true })
    .getByRole('option')
    .first()
    .click();
  await expect(page.locator('.composer-highlights mark')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}

/** Derive expected text rectangles from the native input's computed metrics, independently
 * of the highlight layer. This catches responsive padding, font, wrapping and scroll drift. */
async function expectAligned(page: Page) {
  await expect
    .poll(
      () =>
        page.locator('.composer-editor').evaluate((editor) => {
          const textarea = editor.querySelector('textarea')!;
          const mark = editor.querySelector('mark')!;
          const style = getComputedStyle(textarea);
          const frame = textarea.getBoundingClientRect();
          const probe = document.createElement('div');
          for (const property of [
            'font-family',
            'font-size',
            'font-weight',
            'font-style',
            'font-variant',
            'line-height',
            'letter-spacing',
            'word-spacing',
            'text-indent',
            'text-transform',
            'text-align',
            'direction',
            'tab-size',
            'white-space',
            'overflow-wrap',
            'word-break',
            'padding-top',
            'padding-right',
            'padding-bottom',
            'padding-left',
          ])
            probe.style.setProperty(property, style.getPropertyValue(property));
          Object.assign(probe.style, {
            position: 'fixed',
            left: `${frame.left}px`,
            top: `${frame.top}px`,
            width: `${textarea.clientWidth}px`,
            height: `${textarea.clientHeight}px`,
            boxSizing: 'border-box',
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          });
          const content = document.createElement('div');
          content.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
          content.textContent = textarea.value + '\u200b';
          probe.append(content);
          document.body.append(probe);
          try {
            const start = textarea.value.indexOf(mark.textContent!);
            const range = document.createRange();
            range.setStart(content.firstChild!, start);
            range.setEnd(content.firstChild!, start + mark.textContent!.length);
            const expected = [...range.getClientRects()];
            const actual = [...mark.getClientRects()];
            if (expected.length !== actual.length) return 1000;
            return Math.max(
              0,
              ...expected.flatMap((rect, index) => [
                Math.abs(rect.left - actual[index]!.left),
                Math.abs(rect.top - actual[index]!.top),
                Math.abs(rect.right - actual[index]!.right),
                Math.abs(rect.bottom - actual[index]!.bottom),
              ]),
            );
          } finally {
            probe.remove();
          }
        }),
      {
        message:
          'highlight must cover the native skill text, including after responsive layout changes',
      },
    )
    .toBeLessThanOrEqual(0.5);
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('skill backgrounds follow native text across responsive breakpoints', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await selectSkill(page);
  await input(page).pressSequentially('检查本次修改');
  for (const width of [1280, 761, 760, 390, 320, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await expectAligned(page);
    if (width === 390)
      await page.screenshot({ path: testInfo.outputPath('aligned-skill-narrow.png') });
  }
});

test('wrapped and scrolled skill backgrounds stay aligned after resizing the input', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await selectSkill(page);
  const prefix = '中英 mixed prefix '.repeat(4) + '\n';
  await input(page).evaluate((element: HTMLTextAreaElement, text) => {
    element.setRangeText(text, 0, 0, 'end');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  }, prefix);
  await expect(page.locator('.composer-highlights mark')).toHaveCount(1);
  await expectAligned(page);
  await input(page).fill(prefix + '$review-code ' + '后续内容 following text\n'.repeat(25));
  await input(page).evaluate((element: HTMLTextAreaElement) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => input(page).evaluate((element: HTMLTextAreaElement) => element.scrollTop))
    .toBeGreaterThan(0);
  await expectAligned(page);
  await page.getByRole('separator', { name: '调整输入框高度' }).focus();
  await page.getByRole('separator', { name: '调整输入框高度' }).press('End');
  await expectAligned(page);
  await input(page).evaluate((element: HTMLTextAreaElement) => {
    element.scrollTop = 0;
  });
  await expectAligned(page);
});

test.describe('touch', () => {
  test.use({
    viewport: devices['iPhone 13'].viewport,
    userAgent: devices['iPhone 13'].userAgent,
    isMobile: true,
    hasTouch: true,
  });
  test('skill backgrounds use the same mobile font and inset as the native input', async ({
    page,
  }) => {
    await selectSkill(page);
    await input(page).pressSequentially('检查本次修改');
    await expectAligned(page);
    await input(page).press('Home');
    await input(page).press('ArrowRight');
    await input(page).press('Backspace');
    await expect(input(page)).toHaveValue(' 检查本次修改');
    await expect(page.locator('.composer-highlights mark')).toHaveCount(0);
  });
});

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, selectInterfaceLocale } from './helpers';

const commands = (page: Page) => page.locator('details.activity-command');
const header = (card: Locator) => card.locator(':scope > summary');
const copy = (card: Locator) => card.getByRole('button', { name: '复制命令输出', exact: true });
const feedback = (card: Locator) => card.locator('.command-output-copy-feedback');
const stdout = 'stdout: 你好 & <Covro>\r\n  indented line\n\ttabbed line\n\n';
const failedOutput = 'stdout: starting\nstderr: Error: unavailable\nstdout: cleanup complete\n';

async function start(page: Page, scenario = '[command-output-copy]') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(scenario);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.activity-group')).toBeVisible();
  await page.locator('.activity-group > summary').click();
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.screenshot({ path: `/tmp/covro-command-output-${name}.png`, animations: 'disabled' });
}

test.beforeEach(async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 320, height: 844 },
]) {
  test(`${viewport.name}: the output has its own copy button, with exact text and failed command support`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(commands(page)).toHaveCount(3);
    const first = commands(page).nth(0);
    const failed = commands(page).nth(1);
    const empty = commands(page).nth(2);
    await expect(first).not.toHaveAttribute('open');
    await expect(copy(first)).toBeHidden();
    await expect(header(first).getByRole('button', { name: '复制命令输出' })).toHaveCount(0);
    await header(first).click();
    await expect(copy(first)).toBeVisible();
    await expect(feedback(first)).toBeEmpty();
    const buttonBox = (await copy(first).boundingBox())!;
    const outputBox = (await first.locator('.command-output').boundingBox())!;
    const textBox = (await first.locator('.tool-output').boundingBox())!;
    const commandBox = (await first.locator('pre.command').boundingBox())!;
    expect(buttonBox.y).toBeCloseTo(outputBox.y + 6, 0);
    expect(buttonBox.x + buttonBox.width).toBeCloseTo(outputBox.x + outputBox.width - 6, 0);
    expect(buttonBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
    expect(commandBox.y + commandBox.height).toBeLessThanOrEqual(outputBox.y);
    await first.locator('.command-output').scrollIntoViewIfNeeded();
    await screenshot(page, `${viewport.name}-idle`);
    await copy(first).focus();
    await copy(first).press('Enter');
    await expect(first).toHaveAttribute('open', '');
    await expect(copy(first)).toBeFocused();
    await expect(feedback(first)).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(stdout);
    await expect(feedback(failed)).toBeEmpty();
    await screenshot(page, `${viewport.name}-success`);
    await header(first).click();
    await expect(copy(first)).toBeHidden();

    await header(failed).click();
    await expect(failed).toHaveAttribute('open', '');
    await failed.locator('.tool-output').scrollIntoViewIfNeeded();
    await copy(failed).click();
    await expect(failed).toHaveAttribute('open', '');
    await expect(feedback(failed)).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(failedOutput);
    await expect(failed.locator('.inline-error')).toBeVisible();
    await expect(feedback(failed)).toBeEmpty();
    await header(empty).click();
    await expect(copy(empty)).toBeDisabled();

    await page.reload();
    await page.locator('.activity-group > summary').click();
    await header(commands(page).first()).click();
    await copy(commands(page).first()).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(stdout);
    if (viewport.name === 'desktop') {
      await selectInterfaceLocale(page, 'en');
      await expect(feedback(commands(page).first())).toHaveText('Copied');
      await commands(page)
        .first()
        .getByRole('button', { name: 'Copy command output', exact: true })
        .click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(stdout);
    }
  });
}

test('long streaming output copies all loaded lines and preserves collapse state and keyboard focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, '[activity-stream]');
  const first = commands(page).first();
  await expect(copy(first)).toBeHidden();
  await header(first).click();
  const initial =
    Array.from(
      { length: 140 },
      (_, index) => `unit-test ${String(index + 1).padStart(3, '0')}: passed`,
    ).join('\n') + '\n';
  await copy(first).focus();
  await copy(first).press('Space');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(initial);
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('.tool-output')).toContainText('stream-update-1');
  await expect(copy(first)).toBeFocused();
  await copy(first).press('Enter');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    initial + 'stream-update-1: more test results arrived\n',
  );
  await header(first).click();
  await expect(copy(first)).toBeHidden();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(first).not.toHaveAttribute('open');
  await header(first).click();
  await copy(first).press('Enter');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    initial +
      'stream-update-1: more test results arrived\nstream-update-2: more test results arrived\n',
  );
  await first.locator('.tool-output').evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await copy(first).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'unit-test 140: passed\nstream-update-1:',
  );
  await expect(first).toHaveAttribute('open', '');
  await expect(
    page
      .locator('details.activity:not(.activity-command)')
      .getByRole('button', { name: '复制命令输出' }),
  ).toHaveCount(0);
});

test('truncated output warns in the output area and copies only the loaded portion without claiming completeness', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, '[command-output-truncated]');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const card = commands(page).first();
  await header(card).click();
  await expect(feedback(card)).toHaveText('输出已截断，仅可复制已加载部分。');
  await copy(card).click();
  await expect(card).toHaveAttribute('open', '');
  await expect(feedback(card)).toHaveText('已复制已加载部分（输出已截断）');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const response = await page.request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  const thread = (await response.json()) as ThreadView;
  const item = thread.turns[0]!.items.find((entry) => entry.type === 'commandExecution')!;
  expect(item.truncated).toBe(true);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // HTTP recovery preserves all retained output, including its upstream truncation marker.
  const loaded = await card.locator('.tool-output code').textContent();
  expect(copied).toBe(loaded);
  expect(copied).toBe(item.output);
  expect(copied).not.toContain('[内容已截断；可通过 HTTP 历史读取完整的已保留内容]');
  expect(copied).toMatch(/\n\[输出已截断\]$/);
  expect(copied).not.toContain('not retained');
  await screenshot(page, 'truncated');
  await expect(feedback(card)).toHaveText('输出已截断，仅可复制已加载部分。');
});

for (const failure of ['denied', 'unavailable']) {
  test(`clipboard ${failure}: visible failure on mobile, no false success, and retry`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page);
    await page.evaluate((mode) => {
      const clipboard = navigator.clipboard;
      Reflect.set(window, 'restoreClipboard', () =>
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard }),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          mode === 'unavailable'
            ? undefined
            : { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
      });
    }, failure);
    const card = commands(page).first();
    await header(card).click();
    await copy(card).click();
    await expect(card).toHaveAttribute('open', '');
    await expect(feedback(card)).toHaveText('复制失败，请手动选择输出复制。');
    await expect(page.getByText('已复制', { exact: true })).toHaveCount(0);
    await screenshot(page, `failed-${failure}`);
    await page.evaluate(() => Reflect.get(window, 'restoreClipboard')());
    await copy(card).click();
    await expect(feedback(card)).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(stdout);
  });
}

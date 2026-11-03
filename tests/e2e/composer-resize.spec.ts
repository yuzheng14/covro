import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

const input = (page: Page) => page.locator('.composer-box textarea');
const handle = (page: Page) => page.getByRole('separator', { name: '调整输入框高度' });
const box = (page: Page) => page.locator('.composer-box');

async function drag(page: Page, delta: number) {
  const bounds = (await handle(page).boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y - delta, { steps: 10 });
  await page.mouse.up();
}

async function expectBottom(page: Page, bottom: number) {
  const bounds = (await box(page).boundingBox())!;
  expect(bounds.y + bounds.height).toBeCloseTo(bottom, 0);
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.composer-target')).toHaveCount(0);
});

test('top-right drag follows the pointer both ways, captures outside and preserves the draft', async ({
  page,
}) => {
  await input(page).fill('拖动手柄不会发送或选中这条消息');
  const before = (await box(page).boundingBox())!;
  const textarea = (await input(page).boundingBox())!;
  const grip = (await handle(page).boundingBox())!;
  expect(grip.x + grip.width).toBeCloseTo(before.x + before.width - 1, 0);
  expect(grip.y).toBeCloseTo(before.y + 1, 0);
  expect(grip.width).toBeGreaterThanOrEqual(32);
  await expect(input(page)).toHaveCSS('resize', 'none');
  await expect(handle(page)).toHaveCSS('cursor', 'ns-resize');
  const bottom = before.y + before.height;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await handle(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    '向上拖动增高，向下拖动缩小；也可用方向键调整',
  );
  await page.mouse.down();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(x - 120, y - 70, { steps: 10 });
  await expect
    .poll(async () => Math.round((await input(page).boundingBox())!.height))
    .toBe(Math.round(textarea.height + 70));
  expect((await box(page).boundingBox())!.y).toBeCloseTo(before.y - 70, 0);
  await expectBottom(page, bottom);
  await expect(page.locator('html')).toHaveClass(/composer-resizing/);
  await expect(input(page)).toHaveCSS('cursor', 'ns-resize');
  await expect(input(page)).toBeFocused();
  await page.mouse.move(x - 150, y - 25, { steps: 10 });
  await expect
    .poll(async () => Math.round((await input(page).boundingBox())!.height))
    .toBe(Math.round(textarea.height + 25));
  expect((await box(page).boundingBox())!.y).toBeCloseTo(before.y - 25, 0);
  await expectBottom(page, bottom);
  // Releasing over Send must not turn the drag into a submission.
  const send = (await page.getByRole('button', { name: '发送任务', exact: true }).boundingBox())!;
  await page.mouse.move(send.x + send.width / 2, send.y + send.height / 2);
  await page.mouse.up();
  await expect(page.locator('html')).not.toHaveClass(/composer-resizing/);
  await expect(input(page)).toHaveValue('拖动手柄不会发送或选中这条消息');
  await expect(page.locator('.turn')).toHaveCount(0);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
});

test('height clamps at both limits and long text scrolls inside the editor', async ({ page }) => {
  const text = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行长文本`).join('\n');
  await input(page).fill(text);
  const before = (await box(page).boundingBox())!;
  await drag(page, 600);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '230');
  await expectBottom(page, before.y + before.height);
  expect(await input(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await input(page).press('ControlOrMeta+End');
  expect(await input(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await drag(page, -600);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '93');
  await expectBottom(page, before.y + before.height);
  await expect(input(page)).toHaveValue(text);
});

test('keyboard resize keeps focus and advertises the actual limits', async ({ page }) => {
  await handle(page).focus();
  await handle(page).press('End');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '230');
  await handle(page).press('ArrowDown');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '220');
  await handle(page).press('Shift+ArrowDown');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '180');
  await handle(page).press('ArrowUp');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '190');
  await handle(page).press('Home');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '93');
  await expect(handle(page)).toBeFocused();
  await expect(page.locator('.turn')).toHaveCount(0);
});

test('narrow and short viewports clamp an expanded editor without hiding the controls', async ({
  page,
}) => {
  await handle(page).focus();
  await handle(page).press('End');
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(handle(page)).toHaveAttribute('aria-valuemin', '83');
  await expect
    .poll(async () => Number(await handle(page).getAttribute('aria-valuemax')))
    .toBeLessThan(230);
  await drag(page, 200);
  const maximum = Number(await handle(page).getAttribute('aria-valuemax'));
  const editor = (await input(page).boundingBox())!;
  expect(editor.height).toBeCloseTo(maximum, 0);
  const bottom = page.locator('.bottom-region');
  expect(await bottom.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(
    true,
  );
  const composer = (await box(page).boundingBox())!;
  expect(composer.y).toBeGreaterThan(24);
  expect(composer.y + composer.height).toBeLessThan(480);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await drag(page, -300);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '83');
});

test('real touch drags resize in both directions and touch cancellation releases the cursor', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await expect(handle(page)).toHaveCSS('width', '44px');
  await expect(handle(page)).toHaveCSS('touch-action', 'none');
  await input(page).fill('触控调整时保留的草稿');
  const before = (await box(page).boundingBox())!;
  const height = (await input(page).boundingBox())!.height;
  const bounds = (await handle(page).boundingBox())!;
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  const touch = async (type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel', at: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchCancel' || type === 'touchEnd' ? [] : [{ x, y: at, id: 1 }],
    });
  await touch('touchStart', y);
  await touch('touchMove', y - 60);
  await expect
    .poll(async () => Math.round((await input(page).boundingBox())!.height))
    .toBe(Math.round(height + 60));
  await expectBottom(page, before.y + before.height);
  await touch('touchMove', y - 20);
  await expect
    .poll(async () => Math.round((await input(page).boundingBox())!.height))
    .toBe(Math.round(height + 20));
  await touch('touchCancel', y - 20);
  await expect(page.locator('html')).not.toHaveClass(/composer-resizing/);
  await expect(input(page)).toHaveValue('触控调整时保留的草稿');
  await expect(page.locator('.turn')).toHaveCount(0);
  await cdp.detach();
});

test('the shell panel retains its compact editor limits', async ({ page }) => {
  await page.getByRole('button', { name: '打开 Shell 面板', exact: true }).click();
  await expect(handle(page)).toHaveAttribute('aria-valuemin', '48');
  const max = Number(await handle(page).getAttribute('aria-valuemax'));
  expect(max).toBeGreaterThanOrEqual(48);
  expect(max).toBeLessThanOrEqual(90);
  await handle(page).focus();
  await handle(page).press('End');
  // Font metrics and layout rounding can change the available space after a resize.
  await expect
    .poll(async () =>
      Math.abs(
        (await input(page).boundingBox())!.height -
          Number(await handle(page).getAttribute('aria-valuemax')),
      ),
    )
    .toBeLessThan(1);
  await handle(page).press('Home');
  await expect(input(page)).toHaveCSS('height', '48px');
  await page.getByRole('button', { name: '关闭 Shell 面板', exact: true }).click();
  await expect(handle(page)).toHaveAttribute('aria-valuemin', '93');
  await expect(handle(page)).toHaveAttribute('aria-valuemax', '230');
});

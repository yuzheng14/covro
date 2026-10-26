import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import type { SystemInfo } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  openSidebarSettings,
} from './helpers';

const effortControl = (page: Page) =>
  page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
const effortHint = (page: Page) =>
  page.locator('.control-hint').filter({ has: effortControl(page) });
const effortTooltip = (page: Page) => page.getByRole('tooltip').filter({ hasText: /^推理强度：/ });

async function newThread(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await openModelSettings(page);
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('effort hint reports the exact value on hover and keyboard focus and Escape dismisses it', async ({
  page,
}) => {
  await newThread(page);
  const effort = effortControl(page);
  const hint = effortTooltip(page);
  const input = page.getByRole('textbox', { name: '任务内容', exact: true });
  await expect(effort).toHaveAccessibleDescription('推理强度：medium');
  await expect(hint).toHaveCount(0);
  await input.focus();
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('推理强度：medium');
  await expect(input).toBeFocused();
  await page
    .locator('.composer-box')
    .screenshot({ path: '/tmp/codex-settings-effort-tooltip.png' });
  const popup = page.locator('[data-slot="tooltip-content"]');
  const popupBox = await popup.boundingBox();
  // Follow the pointer path across the gap so Radix can track its hover corridor.
  // The hint stays open when hovered and closes only after leaving both surfaces.
  await page.mouse.move(popupBox!.x + popupBox!.width / 2, popupBox!.y + popupBox!.height / 2, {
    steps: 5,
  });
  await expect(hint).toBeVisible();
  await expect(input).toBeFocused();
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(hint).toHaveCount(0);
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await input.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.mouse.move(0, 0, { steps: 5 });
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(hint).toHaveCount(0);

  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  await model.focus();
  await model.press('Tab');
  await expect(effort).toBeFocused();
  await expect(hint).toBeVisible();
  await effort.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(effort).toBeFocused();
  await effort.press('Shift+Tab');
  await expect(model).toBeFocused();
  await model.press('Tab');
  await expect(hint).toBeVisible();
  await effort.press('Shift+Tab');
  await expect(hint).toHaveCount(0);
});

test('effort hint distinguishes the next task value from the confirmed current value', async ({
  page,
}) => {
  await newThread(page);
  const effort = effortControl(page);
  const hint = effortTooltip(page);
  await effort.click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await expect(effort).toHaveAttribute('aria-expanded', 'false');
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('推理强度：high');
  await expect(hint).toContainText('待应用 · 当前 medium');
  await expect(effort).toHaveAccessibleDescription(/推理强度：high.*待应用 · 当前 medium/);
  await page
    .locator('.composer-box')
    .screenshot({ path: '/tmp/codex-settings-effort-pending-tooltip.png' });

  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('应用新的推理强度');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(effort).toBeEnabled();
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('推理强度：high');
  await expect(effort).toHaveAccessibleDescription('推理强度：high');
});

test('disabled effort controls still expose their current value on hover', async ({ page }) => {
  await newThread(page);
  const effort = effortControl(page);
  const hint = effortTooltip(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[approval] 查看任务运行期间的推理强度');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(effort).toBeDisabled();
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('推理强度：medium');
  await expect(effort).toHaveAccessibleDescription('推理强度：medium');
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
  await page.mouse.move(0, 0, { steps: 5 });
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(hint).toBeVisible();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(effort).toBeEnabled();
});

test('a long unrecognized effort remains readable in a tooltip within a 320px viewport', async ({
  page,
}) => {
  const effortValue =
    'provider-specific-reasoning-effort-with-a-long-unrecognized-version-and-capability-name';
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), reasoningEffort: effortValue },
    });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await confirmCompatibility(page);
  const effort = effortControl(page);
  await openModelSettings(page);
  await expect(effort).toHaveAttribute('data-value', effortValue);
  await expect(effort).toHaveAccessibleDescription(`推理强度：${effortValue}`);
  await openModelSettings(page);
  await effortHint(page).hover();
  await expect(effortTooltip(page)).toHaveText(`推理强度：${effortValue}`);
  const popup = page.locator('[data-slot="tooltip-content"]');
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  const content = await popup.evaluate((element) => {
    const text = element.querySelector('.control-hint-content')!;
    return {
      height: text.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(text).lineHeight),
      fits: element.scrollWidth <= element.clientWidth,
    };
  });
  expect(content.height).toBeGreaterThan(content.lineHeight * 1.5);
  expect(content.fits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/codex-shadcn-mobile-tooltip.png', fullPage: true });
});

test('custom menus support keyboard selection, Escape and outside dismissal without obscuring the menu with hints', async ({
  page,
}) => {
  await newThread(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  const effort = effortControl(page);
  const hint = effortTooltip(page);
  await model.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: 'simulated-model', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({ path: '/tmp/codex-shadcn-model-menu.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute('data-value', 'simulated-model');

  await model.press('Tab');
  await expect(effort).toBeFocused();
  await expect(hint).toBeVisible();
  await effort.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(hint).toHaveCount(0);
  const medium = page.getByRole('option', { name: 'medium', exact: true });
  await expect(medium).toBeFocused();
  await expect(medium).toHaveAttribute('aria-selected', 'true');
  await medium.press('ArrowDown');
  const high = page.getByRole('option', { name: 'high', exact: true });
  await expect(high).toBeFocused();
  await high.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(effort).toBeFocused();
  await expect(page.locator('.settings-pending')).toContainText('当前 simulated-model / medium');

  await effort.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(high).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: '/tmp/codex-shadcn-effort-menu.png', fullPage: true });
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'xhigh', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(effort).toBeFocused();
  await expect(hint).toHaveCount(0);

  const inputBox = await page.getByRole('textbox', { name: '任务内容', exact: true }).boundingBox();
  await effort.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(high).toBeFocused();
  // The modal Select intentionally disables pointer events on outside content.
  // A real outside pointer click must close it without choosing a highlighted option.
  await page.mouse.move(inputBox!.x + 12, inputBox!.y + 12, { steps: 5 });
  await page.mouse.click(inputBox!.x + 12, inputBox!.y + 12);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(effort).toHaveAttribute('data-value', 'high');
});

test('model and effort menus fit a 320px viewport with long model names', async ({ page }) => {
  const longModel = 'private-model-with-a-very-long-provider-and-version-name';
  await page.route('**/api/system', async (route) => {
    const response = await route.fetch();
    const system = (await response.json()) as SystemInfo;
    await route.fulfill({
      response,
      json: {
        ...system,
        models: [...system.models, { ...system.models[0]!, id: longModel, name: longModel }],
      },
    });
  });
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), model: longModel } });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await confirmCompatibility(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  const effort = effortControl(page);
  await openModelSettings(page);
  await expect(model).toHaveAttribute('data-value', longModel);
  await model.click();
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  await expect(page.getByRole('option', { name: longModel, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const modelBox = await menu.boundingBox();
  expect(modelBox!.x).toBeGreaterThanOrEqual(0);
  expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(320);
  expect(modelBox!.y).toBeGreaterThanOrEqual(0);
  expect(modelBox!.y + modelBox!.height).toBeLessThanOrEqual(844);
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/codex-shadcn-mobile-menu.png', fullPage: true });
  await page.unroute('**/api/projects/fixture/runtime-settings');
  await page.getByRole('option', { name: 'simulated-model', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(model).toHaveAttribute('data-value', 'simulated-model');
  await expect(model).toContainText('simulated-model');
  await expect(page.locator('.settings-defaults')).toHaveText('已保存为 Codex 新会话默认值');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await effort.click();
  await expect(menu).toBeVisible();
  await expect(effortTooltip(page)).toHaveCount(0);
  const effortBox = await menu.boundingBox();
  expect(effortBox!.x).toBeGreaterThanOrEqual(0);
  expect(effortBox!.x + effortBox!.width).toBeLessThanOrEqual(320);
  expect(effortBox!.y).toBeGreaterThanOrEqual(0);
  expect(effortBox!.y + effortBox!.height).toBeLessThanOrEqual(844);
  await page.getByRole('option', { name: 'ultra', exact: true }).click();
  await expect(effort).toHaveAttribute('data-value', 'ultra');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Escape closes Slash commands and hovered tooltips together without executing or losing the draft', async ({
  page,
}) => {
  await newThread(page);
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url());
  });
  const input = page.getByRole('textbox', { name: '任务内容', exact: true });
  const menu = page.getByRole('listbox', { name: 'Slash 命令', exact: true });

  for (const control of ['execute', 'summary'] as const) {
    await input.fill('');
    await input.fill('/status');
    await expect(menu).toBeVisible();
    await expect(input).toBeFocused();
    const trigger =
      control === 'execute'
        ? page.getByRole('button', { name: '执行命令', exact: true })
        : page.getByRole('button', { name: '模型设置', exact: true });
    const description =
      control === 'execute'
        ? 'Enter 执行命令 / Esc 关闭菜单'
        : /模型：simulated-model.*推理强度：medium.*Fast 关/;
    await expect(trigger).toHaveAccessibleDescription(description);
    await trigger.hover();
    const hint = page.getByRole('tooltip').filter({ hasText: description });
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(description);
    await expect(input).toBeFocused();
    if (control === 'execute')
      await page.screenshot({ path: '/tmp/codex-shadcn-slash-tooltip.png', fullPage: true });

    // Radix handles Escape at document capture; the editor must still dismiss
    // its Slash menu even when the same event has already dismissed a tooltip.
    await input.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(menu).toHaveCount(0);
    await expect(input).toHaveValue('/status');
    await expect(input).toBeFocused();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator('.slash-feedback')).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: '状态诊断详情', includeHidden: true }),
    ).toBeHidden();
    await expect(page.locator('.turn')).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await page.mouse.move(0, 0, { steps: 5 });
  }

  await input.fill('继续编辑普通任务');
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  await expect(send).toHaveAccessibleDescription('Enter 发送 / Shift + Enter 换行');
  await expect(menu).toHaveCount(0);
  await send.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Enter 发送 / Shift + Enter 换行');
  await expect(input).toHaveValue('继续编辑普通任务');
  await expect(input).toBeFocused();
  await page
    .locator('.composer-box')
    .screenshot({ path: '/tmp/codex-shadcn-rebased-send-tooltip.png' });
  expect(posts).toHaveLength(0);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 320, height: 700 },
]) {
  test(`${viewport.name}: language select stays interactive inside a native modal`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    const dialog = await openSidebarSettings(page);
    const trigger = dialog.locator('.language-selector [role="combobox"]');
    await expect(trigger).toHaveAccessibleName('语言');
    await trigger.focus();
    await trigger.press('ArrowDown');
    const menu = page.getByRole('listbox');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((node) => node.closest('dialog')?.open)).toBe(true);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: info.outputPath(`language-${viewport.name}-menu.png`) });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('data-value', 'zh-Hans');
    await trigger.press('ArrowDown');
    await expect(page.getByRole('option', { name: '简体中文', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('option', { name: '한국어', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute('data-value', 'ko');
    await trigger.click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.sidebar-settings-trigger')).toBeFocused();
  });
}

test('the combined control opens a keyboard-accessible popover and Escape dismisses nested menus first', async ({
  page,
}) => {
  await newThread(page);
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  const summary = page.getByRole('button', { name: '模型设置', exact: true });
  const popup = page.getByRole('dialog', { name: '模型设置', exact: true });
  await expect(summary).toContainText('simulated-model');
  await expect(summary).toContainText('medium');
  await expect(popup).toBeHidden();
  await summary.focus();
  await summary.press('Enter');
  await expect(popup).toBeVisible();
  const close = popup.getByRole('button', { name: '关闭模型设置', exact: true });
  await close.focus();
  await close.press('Tab');
  const model = popup.getByRole('combobox', { name: '模型', exact: true });
  await expect(model).toBeFocused();
  await model.press('ArrowDown');
  await expect(page.getByRole('listbox', { name: '模型', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeVisible();
  await expect(model).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(summary).toBeFocused();
  const input = page.getByRole('textbox', { name: '任务内容', exact: true });
  await input.fill('收起设置后保留文字');
  await summary.click();
  await expect(popup).toBeVisible();
  await input.click({ position: { x: 8, y: 8 } });
  await expect(popup).toBeHidden();
  await expect(input).toHaveValue('收起设置后保留文字');
});

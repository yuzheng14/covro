import { openModelSettings } from './helpers';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const effortControl = (page: Page) =>
  page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
async function chooseEffort(page: Page, value: string) {
  await openModelSettings(page);
  await effortControl(page).click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(effortControl(page)).toHaveAttribute('data-value', value);
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

async function expectReadable(control: Locator) {
  const ratio = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const text = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

const themes = [
  { colorScheme: 'light', preference: 'system', effective: 'light' },
  { colorScheme: 'dark', preference: 'system', effective: 'dark' },
  { colorScheme: 'dark', preference: 'light', effective: 'light' },
  { colorScheme: 'light', preference: 'dark', effective: 'dark' },
] as const;

for (const { colorScheme, preference, effective } of themes) {
  for (const width of [1280, 320]) {
    test(`${preference} theme with ${colorScheme} OS, ${width}px: tiers stay readable and stable through switching`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.addInitScript((theme) => localStorage.setItem('covro.theme', theme), preference);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', effective);
      await confirmCompatibility(page);
      await createEmptyThread(page);
      await expectThreadReady(page);
      await page.setViewportSize({ width, height: 844 });
      await openModelSettings(page);
      const effort = effortControl(page);
      const display = effort.locator('.reasoning-effort-display');
      await expect(effort).toHaveAttribute('data-value', 'medium');
      const ordinaryColor = await effort.evaluate((element) => getComputedStyle(element).color);
      await expect(display).toHaveCSS('animation-name', 'none');
      let tierWidth = 0;

      const dark = effective === 'dark';
      for (const [value, label, color, surface, hover] of [
        [
          'max',
          'Max',
          dark ? 'rgb(201, 181, 140)' : 'rgb(166, 83, 16)',
          dark ? 'rgb(57, 51, 41)' : 'rgb(255, 244, 229)',
          dark ? 'rgb(70, 61, 45)' : 'rgb(255, 234, 208)',
        ],
        [
          'ultra',
          'Ultra',
          dark ? 'rgb(197, 172, 232)' : 'rgb(124, 58, 217)',
          dark ? 'rgb(52, 45, 64)' : 'rgb(244, 237, 255)',
          dark ? 'rgb(64, 54, 79)' : 'rgb(234, 220, 255)',
        ],
      ] as const) {
        await effort.click();
        const option = page.getByRole('option', { name: value, exact: true });
        await option.hover();
        await expect(option).toHaveCSS('color', color);
        await expect(option).toHaveCSS('background-color', hover);
        await expectReadable(option);
        if (value === 'max')
          await page.locator('[data-slot="select-content"]').screenshot({
            path: info.outputPath(`reasoning-menu-${effective}-${width}.png`),
            animations: 'disabled',
          });
        await option.click();
        await expect(effort).toHaveCSS('color', color);
        // The trigger remains hovered after selecting; verify both interaction surfaces.
        await effort.hover();
        await expect(effort).toHaveCSS('background-color', hover);
        await expectReadable(effort);
        await page.mouse.move(0, 0);
        await expect(effort).toHaveCSS('background-color', surface);
        await expectReadable(effort);
        await expect(effort.locator('.reasoning-tier-label')).toHaveText(label);
        await expect(effort.locator('.reasoning-tier-label')).toBeHidden();
        await expect(effort).toHaveAccessibleDescription(new RegExp(`^推理强度：${value}`));
        await expect(display).toHaveCSS('animation-name', `effort-${value}-ignite`);
        const before = await effort.boundingBox();
        if (tierWidth) expect(before!.width).toBe(tierWidth);
        tierWidth = before!.width;
        // Let the real animation finish; the text and surrounding controls must not move.
        await display.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        expect(await effort.boundingBox()).toEqual(before);
        await expect(display).toHaveCSS('box-shadow', 'none');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const row = page.locator('.composer-actions');
        expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        expect(
          (await page
            .getByRole('combobox', { name: '模型', exact: true, includeHidden: true })
            .boundingBox())!.width,
        ).toBeGreaterThanOrEqual(50);
        await page.locator('.model-settings-popover').screenshot({
          path: info.outputPath(`reasoning-${value}-${effective}-${width}.png`),
          animations: 'disabled',
        });

        await effort.click();
        await expect(page.getByRole('option', { name: value, exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await page.getByRole('option', { name: value, exact: true }).press('Escape');
      }

      await chooseEffort(page, 'high');
      await expect(effort).toHaveCSS('color', ordinaryColor);
      await expect(display).toHaveCSS('animation-name', 'none');
      await expect(effort.locator('.reasoning-tier-label')).toHaveCount(0);
      // Undo also restores the ordinary appearance without stale tier effects.
      await chooseEffort(page, 'ultra');
      await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
      await page.getByRole('button', { name: '撤销本会话修改', exact: true }).click();
      await expect(effort).toHaveAttribute('data-value', 'medium');
      await expect(effort).toHaveCSS('color', ordinaryColor);
      await expect(display).toHaveCSS('animation-name', 'none');
    });
  }
}

for (const colorScheme of ['light', 'dark'] as const)
  test(`${colorScheme}: reduced motion keeps readable tier accents without playing animations`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await confirmCompatibility(page);
    const colors = new Set<string>();
    for (const value of ['max', 'ultra']) {
      await chooseEffort(page, value);
      const effort = effortControl(page);
      await expect(effort.locator('.settings-effort-value')).toBeVisible();
      await expect(effort.locator('.reasoning-effort-display')).toHaveCSS('animation-name', 'none');
      await expectReadable(effort);
      colors.add(await effort.evaluate((element) => getComputedStyle(element).color));
      expect(
        await effort.evaluate((element) => element.getAnimations({ subtree: true }).length),
      ).toBe(0);
    }
    expect(colors.size).toBe(2);
  });

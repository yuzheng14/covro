import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
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

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [1280, 320]) {
    test(`${colorScheme} OS preference, ${width}px: tiers keep light styling and stable geometry through switching`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.goto('/');
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

      for (const [value, label, color] of [
        ['max', 'Max', 'rgb(166, 83, 16)'],
        ['ultra', 'Ultra', 'rgb(124, 58, 217)'],
      ] as const) {
        await effort.click();
        const option = page.getByRole('option', { name: value, exact: true });
        await option.hover();
        await expect(option).toHaveCSS('color', color);
        await expect(option).toHaveCSS(
          'background-color',
          value === 'max' ? 'rgb(255, 234, 208)' : 'rgb(234, 220, 255)',
        );
        await option.click();
        await expect(effort).toHaveCSS('color', color);
        await expect(effort).toHaveCSS(
          'background-color',
          value === 'max' ? 'rgb(255, 244, 229)' : 'rgb(244, 237, 255)',
        );
        await expect(effort.locator('.reasoning-tier-label')).toHaveText(label);
        if (width === 320) await expect(effort.locator('.reasoning-tier-label')).toBeHidden();
        else await expect(effort.locator('.reasoning-tier-label')).toBeHidden();
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
        await page.locator('.composer-box').screenshot({
          path: `/tmp/codex-fast-${value}-${width}-${colorScheme}.png`,
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

test('reduced motion keeps both tier accents and labels without playing animations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await confirmCompatibility(page);
  const colors = new Set<string>();
  for (const value of ['max', 'ultra']) {
    await chooseEffort(page, value);
    const effort = effortControl(page);
    await expect(effort.locator('.settings-effort-value')).toBeVisible();
    await expect(effort.locator('.reasoning-effort-display')).toHaveCSS('animation-name', 'none');
    colors.add(await effort.evaluate((element) => getComputedStyle(element).color));
    expect(
      await effort.evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
  }
  expect(colors.size).toBe(2);
});

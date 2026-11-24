import { expect, test } from '@playwright/test';
import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openModelSettings,
} from './helpers';

test.skip(CODEX_COMPATIBILITY.recommended !== '0.172.0', 'Requires the target protocol layer');

test('uses the session provider for model and effort choices, without changing new-session defaults', async ({
  page,
  request,
}) => {
  await controlRuntime(request, {
    reset: true,
    fixtureOptions: {
      modelProvider: 'current',
      configModel: 'current-only',
      threadModelProviders: ['old'],
      modelPageSize: 1,
      providerModels: {
        current: [{ id: 'current-only', efforts: ['low'], tiers: ['fast'] }],
        old: [
          { id: 'old-model', efforts: ['medium'] },
          { id: 'old-alternative', efforts: ['high'] },
        ],
      },
    },
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await openModelSettings(page);
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await expect(page.getByRole('option', { name: 'old-alternative', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'current-only', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'old-alternative', exact: true }).click();
  await expect(page.locator('.settings-defaults')).toHaveText('仅应用于当前会话');
  await page.getByRole('combobox', { name: '推理强度', exact: true }).click();
  await expect(page.getByRole('option', { name: 'high', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'low', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-speed')).toBeDisabled();
  await createEmptyThread(page);
  await openModelSettings(page);
  await page.getByRole('combobox', { name: '模型', exact: true }).click();
  await expect(page.getByRole('option', { name: 'current-only', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'old-alternative', exact: true })).toHaveCount(0);
});

test('keeps a failed provider catalog empty and reports unavailability on a narrow screen', async ({
  page,
  request,
}) => {
  await controlRuntime(request, {
    reset: true,
    fixtureOptions: {
      modelProvider: 'current',
      threadModelProviders: ['old'],
      providerModelFailure: 'old',
    },
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('暂时无法读取此会话的模型选项。', { exact: true })).toBeVisible();
  await openModelSettings(page);
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { controlRuntime, expectThreadReady, testOrigin, compatibilityDialog } from '../e2e/helpers';

/** Native process/socket collection and real Vite; Codex execution events are explicit fixtures. */
export async function exerciseDevPreview(page: Page, captureDirectory?: string) {
  const screenshots: string[] = [];
  const capture = async (name: string, dialog = true) => {
    if (!captureDirectory) return;
    await mkdir(captureDirectory, { recursive: true });
    const path = join(captureDirectory, `${name}.png`);
    if (dialog) await page.locator('.dev-preview-dialog').screenshot({ path });
    else await page.screenshot({ path });
    screenshots.push(path);
  };
  await controlRuntime(page.request, { reset: true, version: '0.167.0' });
  await page.goto('/');
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }).click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
  const select = async (projectId: string, threadId: string) => {
    await page.evaluate(() => {
      location.hash = '';
    });
    await page.evaluate(
      (destination) => {
        location.hash = `notification=${encodeURIComponent(JSON.stringify(destination))}`;
      },
      { projectId, threadId },
    );
    await expectThreadReady(page);
  };
  const create = async (projectId: string) => {
    const response = await page.request.post(`/api/projects/${projectId}/threads`, {
      headers: { Origin: testOrigin },
      data: { clientOperationId: randomUUID() },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const threadId = (await response.json()).result.threadId as string;
    await select(projectId, threadId);
    await controlRuntime(page.request, { preview: { projectId, threadId } });
    return threadId;
  };
  const open = async () => {
    await page.locator('.dev-preview-entry').click();
    await expect(page.locator('.dev-preview-services li')).toHaveCount(1);
  };
  const first = await create('fixture');
  await open();
  const checks = page.locator('.dev-preview-settings').getByRole('switch');
  await expect(checks.nth(0)).toHaveAccessibleName('启用开发预览代理');
  await expect(checks.nth(1)).toHaveAccessibleName('允许完整请求 · 高危');
  await expect(checks.nth(0)).not.toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await expect(checks.nth(1)).toBeDisabled();
  await expect(page.locator('.dev-preview-services button')).toBeDisabled();
  await capture('default-off');
  await checks.nth(0).focus();
  await expect(checks.nth(0)).toBeFocused();
  let releaseSave!: () => void;
  let startedSave!: () => void;
  let saveRequests = 0;
  const saving = new Promise<void>((resolve) => {
    startedSave = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  // Delay the real settings request to exercise pending UI, then let it reach
  // the fixture server. No policy response or service identity is mocked.
  await page.route('**/api/preview/settings', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saveRequests++;
    startedSave();
    await saveGate;
    await route.continue();
  });
  try {
    await checks.nth(0).press('Space');
    await saving;
    await expect(checks.nth(0)).toBeDisabled();
    await expect(checks.nth(1)).toBeDisabled();
    await expect(checks.nth(0)).toBeFocused();
    await checks.nth(0).press('Space');
    expect(saveRequests).toBe(1);
    await capture('saving');
  } finally {
    releaseSave();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(0)).toBeFocused();
  await capture('enabled-keyboard');
  await expect(page.locator('.dev-preview-services button')).toBeEnabled();
  const launch = async (title: string) => {
    const popup = page.waitForEvent('popup');
    await page.locator('.dev-preview-services button').click();
    const preview = await popup;
    await expect(preview.locator('h1')).toHaveText(title);
    expect(await preview.evaluate(() => window.opener)).toBeNull();
    expect(await preview.evaluate(() => window.origin)).toBe('null');
    await expect(preview.locator('.sidebar')).toHaveCount(0);
    return preview;
  };
  const atlas = await launch('Atlas');
  await page.keyboard.press('Escape');
  const second = await create('fixture-other');
  await open();
  await expect(page.locator('.dev-preview-service strong')).toHaveText('另一个项目');
  const beacon = await launch('Beacon');
  await expect(atlas.locator('h1')).toHaveText('Atlas');
  await capture('two-project-manager', false);
  if (captureDirectory) {
    for (const [name, preview] of [
      ['atlas', atlas],
      ['beacon', beacon],
    ] as const) {
      const path = join(captureDirectory, `${name}.png`);
      await preview.screenshot({ path });
      screenshots.push(path);
    }
  }
  await page.getByText('允许完整请求 · 高危', { exact: true }).click();
  await expect(checks.nth(1)).toBeChecked();
  await capture('full-risk');
  expect((await page.request.get(beacon.url())).status()).toBe(410);
  await checks.nth(1).click();
  await expect(checks.nth(1)).not.toBeChecked();
  for (const locale of ['en', 'zh-Hans', 'ja', 'ko']) {
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [390, 844, 'narrow'],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((locale) => localStorage.setItem('covro.locale', locale), locale);
      await page.reload();
      await select('fixture-other', second);
      await open();
      await expect(page.locator('.dev-preview-dialog')).not.toContainText('dev_');
      const box = await page.locator('.dev-preview-dialog').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await capture(`${locale}-${name}`);
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  await controlRuntime(page.request, { stopPreview: second });
  await expect(page.locator('.dev-preview-services button')).toBeDisabled();
  await capture('withdrawn');
  await checks.nth(0).press('Enter');
  await expect(checks.nth(0)).not.toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await expect(checks.nth(1)).toBeDisabled();
  expect((await page.request.get(atlas.url())).status()).toBe(410);
  await controlRuntime(page.request, { restart: true });
  await page.keyboard.press('Escape');
  // Reload/acknowledge the new epoch before selecting. A reload must not race
  // and discard an in-flight notification destination.
  await page.reload();
  await expect(page.locator('.compatibility-dialog')).toBeVisible();
  await page.locator('.compatibility-dialog button').last().click();
  await expect(page.locator('.compatibility-dialog')).not.toBeVisible();
  await select('fixture', first);
  await page.locator('.dev-preview-entry').click();
  await expect(page.locator('.dev-preview-services li')).toHaveCount(0);
  expect((await page.request.get(atlas.url())).status()).toBe(410);
  await atlas.close();
  await beacon.close();
  return screenshots;
}

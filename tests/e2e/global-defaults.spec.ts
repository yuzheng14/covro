import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, openSidebarSettings, testOrigin } from './helpers';
async function openDefaults(page: Page) {
  await openSidebarSettings(page, 'ai');
  const dialog = page.getByRole('region', { name: '会话默认设置', exact: true });
  await expect(dialog.getByRole('combobox', { name: '默认模型', exact: true })).toBeVisible();
  return dialog;
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('global defaults persist across reload, affect new threads, and preserve existing conversations', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  const created = await request.post('/api/projects/fixture/threads', {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  const originalId = (await created.json()).result.threadId;
  const before = (await (await request.get(`/api/threads/${originalId}`)).json()).runtimeSettings;
  let dialog = await openDefaults(page);
  await dialog.getByRole('combobox', { name: '默认权限模式', exact: true }).click();
  await page.getByRole('option', { name: '帮我批准', exact: true }).click();
  await dialog.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await dialog.getByRole('combobox', { name: '默认推理强度', exact: true }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await dialog.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('默认设置已保存');
  const snapshot = await (await request.get('/api/settings/defaults')).json();
  expect(snapshot.settings).toEqual({
    model: 'simulated-alternative',
    reasoningEffort: 'high',
    permissionMode: 'auto-review',
  });
  expect((await (await request.get(`/api/threads/${originalId}`)).json()).runtimeSettings).toEqual(
    before,
  );
  const next = await request.post('/api/projects/fixture/threads', {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  const nextId = (await next.json()).result.threadId;
  expect(
    (await (await request.get(`/api/threads/${nextId}`)).json()).runtimeSettings,
  ).toMatchObject({
    model: 'simulated-alternative',
    reasoningEffort: 'high',
    permissionMode: 'auto-review',
  });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const path = info.outputPath(`global-defaults-${theme}-${width}.png`);
      await dialog.screenshot({ path });
      await info.attach(`defaults-${theme}-${width}`, { path, contentType: 'image/png' });
    }
  }
  await page.reload();
  dialog = await openDefaults(page);
  await expect(dialog.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
    'simulated-alternative',
  );
  await expect(dialog.getByRole('combobox', { name: '默认推理强度', exact: true })).toContainText(
    'high',
  );
  await expect(dialog.getByRole('combobox', { name: '默认权限模式', exact: true })).toContainText(
    '帮我批准',
  );
  const invalid = await request.post('/api/settings/defaults', {
    headers: { Origin: testOrigin },
    data: {
      clientOperationId: randomUUID(),
      version: snapshot.version,
      settings: {
        model: 'simulated-model',
        reasoningEffort: 'high',
        permissionMode: 'auto-review',
      },
      filePath: '/tmp/not-allowed.toml',
    },
  });
  expect(invalid.status()).toBe(400);
});

test('unsaved defaults require confirmation before closing and model defaults can be restored', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const dialog = await openDefaults(page);
  await dialog.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await page.getByRole('option', { name: '使用 Codex 默认模型', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '默认推理强度', exact: true })).toContainText(
    '使用模型默认强度',
  );
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert')).toContainText('放弃尚未保存');
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await dialog.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('默认设置已保存');
  const snapshot = await (await request.get('/api/settings/defaults')).json();
  expect(snapshot.settings.reasoningEffort).toBe(null);
  await page.locator('.settings-heading button').click();
  await expect(dialog).not.toBeVisible();
});

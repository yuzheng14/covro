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

for (const status of [503, 409])
  test(`an unconfirmed save (${status}) is reread without another write and reopening reads current Codex defaults`, async ({
    page,
    request,
  }, info) => {
    await page.goto('/');
    await confirmCompatibility(page);
    let dialog = await openDefaults(page);
    let writes = 0;
    await page.route('**/api/settings/defaults', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++;
      expect(Object.keys(route.request().postDataJSON()).sort()).toEqual(['settings', 'version']);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      await route.fulfill({
        status,
        json: {
          error: {
            code: 'RPC_TIMEOUT',
            message: 'Fixture acknowledgement lost',
            details: { uncertain: true },
          },
        },
      });
    });
    await dialog.getByRole('combobox', { name: '默认模型', exact: true }).click();
    await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
    await dialog.getByRole('button', { name: '保存默认设置', exact: true }).click();
    await expect(
      dialog.getByText('保存结果尚未确认，请重新读取核对后再操作。', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存默认设置', exact: true })).toBeDisabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const path = info.outputPath('defaults-unconfirmed-' + width + '.png');
      await dialog.screenshot({ path });
      await info.attach('defaults-unconfirmed-' + width, { path, contentType: 'image/png' });
    }
    await dialog.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(
      dialog.getByText('保存结果尚未确认，请重新读取核对后再操作。', { exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
      'simulated-alternative',
    );
    expect(writes).toBe(1);
    await page.locator('.settings-heading button').click();
    await expect(dialog).not.toBeVisible();
    const snapshot = await (await request.get('/api/settings/defaults')).json();
    const external = await request.post('/api/settings/defaults', {
      headers: { Origin: testOrigin },
      data: {
        version: snapshot.version,
        settings: { ...snapshot.settings, model: 'simulated-model', reasoningEffort: 'medium' },
      },
    });
    expect(external.status()).toBe(200);
    dialog = await openDefaults(page);
    await expect(dialog.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
      'simulated-model',
    );
  });

test('a definite version conflict allows reload without reporting an uncertain write', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const dialog = await openDefaults(page);
  const snapshot = await (await request.get('/api/settings/defaults')).json();
  expect(
    (
      await request.post('/api/settings/defaults', {
        headers: { Origin: testOrigin },
        data: {
          version: snapshot.version,
          settings: {
            ...snapshot.settings,
            model: 'simulated-alternative',
            reasoningEffort: 'high',
          },
        },
      })
    ).status(),
  ).toBe(200);
  await dialog.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await page.getByRole('option', { name: '使用 Codex 默认模型', exact: true }).click();
  await dialog.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(
    dialog.getByText('保存结果尚未确认，请重新读取核对后再操作。', { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '重新读取', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
    'simulated-alternative',
  );
});

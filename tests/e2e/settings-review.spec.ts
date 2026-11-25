import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  openSidebarSettings,
  projectGroup,
} from './helpers';

for (const width of [1440, 390])
  test(`mixed permission layers remain undetermined before native creation at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await controlRuntime(request, {
      reset: true,
      fixtureOptions: {
        configOverrides: { default_permissions: ':read-only', sandbox_mode: 'workspace-write' },
        threadSandbox: 'workspace-write',
      },
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await confirmCompatibility(page);
    const navigation = page.getByRole('button', { name: '打开项目与会话', exact: true });
    if (await navigation.isVisible()) await navigation.click();
    await projectGroup(page).getByRole('button', { name: '新建会话', exact: true }).click();
    const permission = page.getByRole('combobox', { name: '权限模式', exact: true });
    await expect(permission).toContainText('无法判断模式');
    await expect(permission).toHaveAccessibleDescription('权限模式：无法判断模式');
    await expect(permission).not.toContainText('只读');
    await page
      .locator('.composer-box')
      .screenshot({ path: info.outputPath(`permission-undetermined-${width}.png`) });
    if (await navigation.isVisible()) await navigation.click();
    await createEmptyThread(page);
    await expect(permission).toContainText('请求批准');
    await expect(permission).toHaveAccessibleDescription('权限模式：请求批准');
    await expect(permission).not.toContainText('只读');
    // Empty conversations are intentionally absent from persistent navigation.
    // Materialize mock history before checking a reload of this conversation.
    await page
      .getByRole('textbox', { name: '任务内容', exact: true })
      .fill('Check fixture permissions [title-fail]');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await page.reload();
    await expect(permission).toContainText('请求批准');
  });

test('global defaults show the current global provider instead of the startup catalog', async ({
  page,
  request,
}, info) => {
  await controlRuntime(request, {
    reset: true,
    fixtureOptions: {
      modelProvider: 'startup',
      configOverrides: { model_provider: 'global' },
      configModel: 'global-model',
      providerModels: {
        startup: [{ id: 'startup-model', efforts: ['medium'] }],
        global: [
          { id: 'global-model', efforts: ['medium'] },
          { id: 'global-alternative', efforts: ['high'] },
        ],
      },
      modelPageSize: 1,
    },
  });
  await page.goto('/');
  await confirmCompatibility(page);
  const settings = await openSidebarSettings(page, 'ai');
  await settings.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await expect(page.getByRole('option', { name: 'global-alternative', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'startup-model', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'global-alternative', exact: true }).click();
  await settings.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('默认设置已保存');
  await settings
    .locator('.global-defaults-dialog')
    .screenshot({ path: info.outputPath('global-provider-saved.png') });
});

test('continuing an unsaved edit preserves the draft until explicit close', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  const settings = await openSidebarSettings(page, 'ai');
  await settings.getByRole('combobox', { name: '默认模型', exact: true }).click();
  await page.getByRole('option', { name: 'simulated-alternative', exact: true }).click();
  await settings.locator('[data-settings-category="account"]').click();
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '默认模型', exact: true })).toContainText(
    'simulated-alternative',
  );
  await settings.locator('.settings-heading button').click();
  await settings.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(settings).not.toBeVisible();
});

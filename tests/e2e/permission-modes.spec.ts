import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode, RuntimeSettings, ThreadView } from '../../src/shared/types';
import { permissionModes } from '../../src/shared/permissions';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  projectGroup,
  expectThreadReady,
} from './helpers';

const evidence = join(tmpdir(), 'codex-issue-72-evidence');
const modeControl = (page: Page) => page.getByRole('combobox', { name: '权限模式', exact: true });
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
}
async function newThread(page: Page) {
  await open(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(modeControl(page)).toHaveAttribute('data-value', 'read-only');
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function choose(page: Page, mode: PermissionMode) {
  await modeControl(page).click();
  await page.getByRole('option', { name: permissionModes[mode].label, exact: true }).click();
  await expect(modeControl(page)).toHaveAttribute('aria-expanded', 'false');
}
async function send(page: Page, text = '验证权限模式') {
  const previousTurns = await page.locator('.turn-heading').count();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading')).toHaveCount(previousTurns + 1);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('one permission menu supports keyboard selection, actual confirmation and all four complete modes', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const id = await newThread(page);
  await expect(page.getByRole('combobox', { name: '权限范围', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '审批策略', exact: true })).toHaveCount(0);
  const control = modeControl(page);
  await control.focus();
  await control.press('Enter');
  await expect(page.getByRole('option', { name: '只读', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await screenshot(page, 'desktop-menu');
  await page.keyboard.press('Home');
  await expect(page.getByRole('option', { name: '请求批准', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(control).toHaveAttribute('data-value', 'ask');
  await expect(control).toBeFocused();
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  for (const mode of ['ask', 'auto-review', 'full-access', 'read-only'] as const) {
    await choose(page, mode);
    await expect(page.locator('.settings-pending')).toContainText(
      `权限待生效：${permissionModes[mode].label}`,
    );
    const before = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
    expect(before.runtimeSettings?.permissionMode).not.toBe(mode);
    const sending = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/turns'),
    );
    await send(page);
    expect((await sending).postDataJSON().settings).toEqual({ permissionMode: mode });
    await expect(page.locator('.settings-pending')).toHaveCount(0);
    const actual = ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView)
      .runtimeSettings;
    expect(actual).toMatchObject({
      permissionMode: mode,
      sandbox: permissionModes[mode].sandbox,
      approvalPolicy: permissionModes[mode].approvalPolicy,
      approvalReviewer: permissionModes[mode].approvalReviewer,
      networkAccess: mode === 'full-access',
    });
    if (mode === 'auto-review') {
      await page.getByRole('button', { name: '权限详情', exact: true }).click();
      await expect(page.locator('.settings-observed')).toContainText('审批执行方：auto_review');
      await screenshot(page, 'desktop-confirmed-auto-review');
      await page.getByRole('button', { name: '权限详情', exact: true }).click();
    }
  }
  await page.reload();
  await expect(control).toHaveAttribute('data-value', 'read-only');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('manual and automatic review keep the same sandbox and route eligible fixture approvals differently', async ({
  page,
  request,
}) => {
  const id = await newThread(page);
  await choose(page, 'ask');
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[mode-approval] 请求人工审批');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(modeControl(page)).toBeEnabled();
  const manual = ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView)
    .runtimeSettings;
  await page.locator('.action-card').getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await choose(page, 'auto-review');
  await send(page, '[mode-approval] 由自动审核处理');
  const actual = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(actual.runtimeSettings).toMatchObject({
    sandbox: manual?.sandbox,
    networkAccess: manual?.networkAccess,
    approvalPolicy: 'on-request',
    approvalReviewer: 'auto_review',
  });
  expect(actual.actions.filter((action) => action.status === 'pending')).toHaveLength(0);
  expect(actual.turns.at(-1)?.items.some((item) => item.autoReview?.status === 'approved')).toBe(
    true,
  );
});

test('custom profile details and unavailable modes stay readable on desktop and narrow screens', async ({
  page,
}) => {
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    const current = (await response.json()) as RuntimeSettings;
    await route.fulfill({
      response,
      json: {
        ...current,
        permissionMode: 'custom',
        permissionProfile: { id: 'company-review', extends: ':workspace' },
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalReviewer: 'user',
        networkAccess: true,
        writableRoots: ['/workspace/shared-assets'],
        permissionCapabilities: {
          ...current.permissionCapabilities,
          autoReview: false,
          allowedProfiles: [':workspace', ':read-only'],
        },
      },
    });
  });
  await open(page);
  await expect(modeControl(page)).toHaveAttribute('data-value', 'custom');
  await expect(modeControl(page)).toContainText('自定义 · company-review');
  await page.getByRole('button', { name: '权限详情', exact: true }).click();
  await expect(page.locator('.permission-values')).toContainText('/workspace/shared-assets');
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：允许');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await screenshot(page, 'desktop-custom-details');
  await modeControl(page).click();
  await expect(page.getByRole('option', { name: '完全访问', exact: true })).toBeDisabled();
  await expect(page.getByRole('option', { name: '帮我批准', exact: true })).toBeDisabled();
  await expect(page.getByRole('listbox')).toContainText('受管要求不允许此权限 profile');
  await expect(page.getByRole('listbox')).toContainText('未启用自动审核');
  await screenshot(page, 'desktop-restricted-menu');
  await page.keyboard.press('Escape');
  await expect(modeControl(page)).toBeFocused();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await modeControl(page).click();
    const bounds = await page.getByRole('listbox').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await screenshot(page, `mobile-restricted-menu-${width}`);
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('keeps a rejected mode pending and keeps the actual permissions visible', async ({ page }) => {
  await newThread(page);
  await choose(page, 'auto-review');
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'PERMISSION_MODE_UNAVAILABLE', message: '受管策略拒绝切换' } },
    }),
  );
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('尝试切换');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '受管策略拒绝切换' }).last(),
  ).toBeVisible();
  await expect(page.locator('.settings-pending')).toContainText('当前：只读');
  await expect(page.locator('.settings-pending')).toContainText('权限待生效：帮我批准');
  await page.getByRole('button', { name: '权限详情', exact: true }).click();
  await expect(page.locator('.settings-note').first()).toContainText('当前模式：只读');
  await screenshot(page, 'rejected-selection');
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  await expect(modeControl(page)).toHaveAttribute('data-value', 'read-only');
});

test('preserves mode drafts by project and conversation and never substitutes defaults during history loading', async ({
  page,
}) => {
  const first = await newThread(page);
  await send(page, '已有会话历史 [title-fail]');
  await choose(page, 'auto-review');
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(modeControl(page)).toHaveAttribute('data-value', 'read-only');
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(modeControl(page)).toHaveAttribute('data-value', 'auto-review');
  await expect(page.locator('.settings-pending')).toContainText('当前：只读');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(modeControl(page)).toHaveAttribute('data-value', '');
  await choose(page, 'ask');
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(modeControl(page)).toHaveAttribute('data-value', 'auto-review');
  await page.reload();
  await expect(modeControl(page)).toHaveAttribute('data-value', 'auto-review');
  await expect(page.locator('.settings-pending')).toContainText('当前：只读');
});

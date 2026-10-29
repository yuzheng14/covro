import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  projectGroup,
  saveConversationHistory,
  expectThreadReady,
} from './helpers';

async function chooseEffort(page: Page, value: string) {
  const trigger = page.getByRole('combobox', {
    name: '推理强度',
    exact: true,
    includeHidden: true,
  });
  await openModelSettings(page);
  await trigger.click();
  await page.getByRole('option', { name: value, exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('direct selectors show reported settings, keep proposals distinct and follow server confirmation', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  await expect(model).toHaveAttribute('data-value', 'simulated-model');
  await expect(effort).toHaveAttribute('data-value', 'medium');
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(effort).toHaveAttribute('data-value', 'medium');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-direct.png' });
  await chooseEffort(page, 'high');
  await expect(page.locator('.settings-pending')).toContainText(
    '下次任务生效 · 当前 simulated-model / medium',
  );
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-pending.png' });
  await page.getByRole('textbox', { name: '任务内容' }).fill('确认推理强度设置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(effort).toBeEnabled();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await expect(effort).toBeEnabled();
  await chooseEffort(page, 'low');
  await page.getByRole('button', { name: '撤销本会话修改' }).click();
  await expect(effort).toHaveAttribute('data-value', 'high');
  await page.reload();
  await expect(effort).toHaveAttribute('data-value', 'high');
  await page.getByRole('button', { name: '权限详情' }).click();
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    'read-only',
  );
  await expect(page.locator('.permission-values')).toContainText('由 Codex 请求审批');
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：受限');
  await expect(page.locator('.settings-panel')).not.toContainText('继承');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-advanced.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: '/tmp/codex-toolbar-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '权限详情' }).click();
  await page.screenshot({ path: '/tmp/codex-toolbar-mobile-collapsed.png', fullPage: true });
});

test('remembers new-thread defaults while keeping each existing session proposal separate', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const first = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await saveConversationHistory(page);
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  await chooseEffort(page, 'high');
  await createEmptyThread(page);
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await chooseEffort(page, 'low');
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(effort).toHaveAttribute('data-value', 'high');
  const sending = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/turns'),
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('独立会话配置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await sending).postDataJSON().settings).toEqual({ reasoningEffort: 'high' });
  await expect(page.getByText('模拟任务已完成。', { exact: true }).last()).toBeVisible();
});

test('keeps project defaults isolated when a previous project responds late', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  await expect(effort).toHaveAttribute('data-value', 'high');
  const oldResponse = page.waitForResponse('**/api/projects/fixture/runtime-settings');
  release();
  await oldResponse;
  await expect(effort).toHaveAttribute('data-value', 'high');
});

test('retries unavailable defaults and preserves unknown or custom values without inventing defaults', async ({
  page,
}) => {
  let failed = true;
  await page.route('**/runtime-settings', async (route) => {
    if (failed)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CODEX_UNAVAILABLE', message: 'unavailable' } },
      });
    else
      await route.fulfill({
        json: {
          model: 'private-custom-model',
          reasoningEffort: null,
          sandbox: 'external-sandbox',
          approvalPolicy: 'granular',
          networkAccess: true,
          approvalReviewer: 'auto_review',
        },
      });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.settings-error')).toContainText('无法读取默认配置');
  failed = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true }),
  ).toHaveAttribute('data-value', 'private-custom-model');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  await expect(effort).toHaveAccessibleDescription('推理强度：未报告');
  await expect(effort).toBeDisabled();
  await expect(page.locator('.reasoning-gauge text')).toHaveText('?');
  await page.getByRole('button', { name: '权限详情' }).click();
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    'custom',
  );
  await expect(page.locator('.permission-values')).toContainText('自定义审批规则');
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：允许');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('all reported effort levels have distinct gauges, including xhigh, max and ultra', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  const gauge = page.locator('.reasoning-gauge');
  let previousProgress = -1;
  let previousArc: string | null = null;
  let previousNeedle: string | null = null;
  for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    await chooseEffort(page, value);
    await expect(effort).toHaveAccessibleDescription(new RegExp(`^推理强度：${value}`));
    await expect(effort).toHaveAttribute('data-value', value);
    await expect(gauge.locator('text')).toHaveCount(0);
    const progress = Number(await gauge.getAttribute('data-progress'));
    const arc = await gauge.locator('path[stroke-dasharray]').getAttribute('stroke-dasharray');
    const needle = await gauge.locator('path').last().getAttribute('d');
    expect(progress).toBeGreaterThan(previousProgress);
    expect(arc).not.toBe(previousArc);
    expect(needle).not.toBe(previousNeedle);
    previousProgress = progress;
    previousArc = arc;
    previousNeedle = needle;

    if (['xhigh', 'max', 'ultra'].includes(value)) {
      await page.getByRole('textbox', { name: '任务内容' }).fill(`确认推理强度：${value}`);
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
      await expect(page.locator('.settings-pending')).toHaveCount(0);
      await expect(effort).toBeEnabled();
      await expect(effort).toHaveAttribute('data-value', value);
      await page
        .locator('.composer-box')
        .screenshot({ path: `/tmp/codex-fix-effort-${value}.png` });
    }
  }
  await page.reload();
  await expect(effort).toHaveAttribute('data-value', 'ultra');
  await expect(gauge.locator('text')).toHaveCount(0);
});

test('idle history reports complete permissions immediately after resume', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'free' });
  await page.addInitScript((id) => {
    localStorage.setItem('codex-web.project', 'fixture');
    localStorage.setItem('codex-web.selected:fixture', id!);
  }, id);
  await page.goto('/');
  await confirmCompatibility(page);
  const policy = page.getByRole('combobox', { name: '权限模式', exact: true });
  await expect(policy).toContainText('只读');
  await page.getByRole('button', { name: '权限详情', exact: true }).click();
  await expect(page.locator('.settings-heading')).toContainText('会话当前配置');
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    'read-only',
  );
  await expect(page.locator('.permission-values')).toContainText('由 Codex 请求审批');
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：受限');
  await expect(page.locator('.settings-observed')).toContainText('审批执行方：user');
  await expect(page.locator('.settings-panel')).not.toContainText('未报告');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-fix-permissions.png' });
});

test('restored saved settings stay distinct from edits until the next task confirms them', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'occupied' });
  await page.addInitScript((id) => {
    localStorage.setItem('codex-web.project', 'fixture');
    localStorage.setItem('codex-web.selected:fixture', id!);
  }, id);
  await page.goto('/');
  await confirmCompatibility(page);
  const notice = page.locator('.session-resume-notice');
  await expect(notice).toContainText('此会话正被其他进程使用');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true });
  await expect(effort).toHaveAttribute('data-value', 'medium');
  await page.getByRole('button', { name: '权限详情' }).click();
  // An occupied history has not resumed, so its saved model does not imply known permissions.
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toContainText(
    '未报告',
  );
  await expect(page.locator('.settings-heading')).toContainText('会话保存配置');
  await chooseEffort(page, 'high');
  await expect(page.locator('.settings-pending')).toContainText('恢复后发送或 Fork 时生效');
  await controlRuntime(request, { releaseThreadId: id });
  const resuming = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/resume'),
  );
  await notice.getByRole('button', { name: '重试恢复', exact: true }).click();
  expect((await resuming).postDataJSON().settings).toBeUndefined();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.settings-pending')).toContainText(
    '下次任务生效 · 当前 simulated-model / medium',
  );
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(page.getByRole('combobox', { name: '权限模式', exact: true })).toHaveAttribute(
    'data-value',
    'read-only',
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('恢复后应用选择');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(effort).toHaveAttribute('data-value', 'high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('combined settings and attachment controls fit on one row, including active tasks and small viewports', async ({
  page,
}) => {
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        model: 'private-model-with-a-very-long-provider-and-version-name',
      },
    });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  const row = page.locator('.composer-actions');
  const summary = row.getByRole('button', { name: '模型设置', exact: true });
  for (const active of [false, true]) {
    if (active) {
      await page.setViewportSize({ width: 1280, height: 844 });
      await createEmptyThread(page);
      await page
        .getByRole('textbox', { name: '任务内容', exact: true })
        .fill('[approval] 检查运行中的发送栏');
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect(page.locator('.action-card')).toBeVisible();
    }
    for (const width of [1280, 1000, 900, 760, 600, 430, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const controls = await page
        .locator('.composer-context > *, .composer-send-controls > *')
        .all();
      const boxes = (await Promise.all(controls.map((control) => control.boundingBox()))).filter(
        (box) => box !== null,
      );
      const centers = boxes.map((box) => box.y + box.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
      for (let index = 1; index < boxes.length; index++)
        expect(boxes[index]!.x).toBeGreaterThanOrEqual(
          boxes[index - 1]!.x + boxes[index - 1]!.width,
        );
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await summary.boundingBox())!.width).toBeGreaterThanOrEqual(70);
      await openModelSettings(page);
      const panel = page.getByRole('dialog', { name: '模型设置', exact: true });
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      await expect(panel.getByRole('combobox', { name: '模型', exact: true })).toBeVisible();
      await expect(panel.getByRole('combobox', { name: '推理强度', exact: true })).toBeVisible();
      if (active)
        await expect(panel.getByRole('button', { name: 'Fast 模式', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: '中断', exact: true }).click();
});

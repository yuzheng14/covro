import { openModelSettings } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  openSidebarSettings,
  projectGroup,
  saveConversationHistory,
} from './helpers';

const input = (page: Page) => page.locator('.composer-box textarea');
const chord = 'Meta+Alt+N';
const macKey = { key: 'n', code: 'KeyN', metaKey: true, altKey: true };
const selected = (page: Page, scope = 'fixture') =>
  page.evaluate((id) => localStorage.getItem(`codex-web.selected:${id}`), scope);

async function open(page: Page, platform = 'MacIntel') {
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, 'platform', { value: platform });
  }, platform);
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const device of [
  { name: 'macOS', platform: 'MacIntel', chord, hint: '⌘ + ⌥ + N', aria: 'Meta+Alt+N' },
  {
    name: 'Windows',
    platform: 'Win32',
    chord: 'Control+Alt+N',
    hint: 'Ctrl + Alt + N',
    aria: 'Control+Alt+N',
  },
  {
    name: 'Linux',
    platform: 'Linux x86_64',
    chord: 'Control+Alt+N',
    hint: 'Ctrl + Alt + N',
    aria: 'Control+Alt+N',
  },
]) {
  test(`${device.name} opens the current project's draft, focuses it and preserves session drafts`, async ({
    page,
  }, testInfo) => {
    await open(page, device.platform);
    const group = projectGroup(page, '另一个项目');
    await group.getByRole('button', { name: '另一个项目', exact: true }).click();
    await saveConversationHistory(page);
    const threadId = (await selected(page, 'fixture-other'))!;
    await input(page).fill('原会话未发送的内容');
    await input(page).evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(
          [
            Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
              ),
              (c) => c.charCodeAt(0),
            ),
          ],
          'draft.png',
          { type: 'image/png' },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator('.composer-images img')).toHaveCount(1);
    await group.getByRole('button', { name: '另一个项目', exact: true }).click();
    await input(page).fill('当前项目的新会话草稿');
    await page.locator(`[data-thread-id="${threadId}"]`).click();
    await expect(input(page)).toHaveValue('原会话未发送的内容');
    const creates: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/threads$/.test(request.url()))
        creates.push(request.url());
    });
    const button = group.getByRole('button', { name: '新建会话', exact: true });
    await expect(button).toHaveAccessibleDescription(`新建会话 · ${device.hint}`);
    await expect(button).toHaveAttribute('aria-keyshortcuts', device.aria);
    await expect(createThreadButton(page)).not.toHaveAttribute('aria-keyshortcuts');
    await button.hover();
    await expect(page.getByRole('tooltip')).toContainText(device.hint);
    await page.screenshot({ path: testInfo.outputPath(`shortcut-${device.name}.png`) });
    await input(page).focus();
    await page.keyboard.press(device.chord);
    await expect(page.getByTestId('workspace-start')).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('当前项目的新会话草稿');
    expect(await selected(page, 'fixture-other')).toBeNull();
    await expect(page.locator('.breadcrumb')).toContainText('另一个项目');
    await expect(page.locator('.composer-images img')).toHaveCount(0);
    await page.keyboard.press(device.chord);
    await expect(input(page)).toHaveValue('当前项目的新会话草稿');
    expect(creates).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`new-session-${device.name}.png`) });
    await page.locator(`[data-thread-id="${threadId}"]`).click();
    await expect(input(page)).toHaveValue('原会话未发送的内容');
    await expect(page.locator('.composer-images img')).toHaveCount(1);
    await button.click();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('当前项目的新会话草稿');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('/api/projects/fixture-other/threads');
  });
}

test('composition, repeat, handled keys and other modifier combinations never navigate', async ({
  page,
}) => {
  await open(page);
  await saveConversationHistory(page);
  const threadId = await selected(page);
  await input(page).fill('保留草稿');
  for (const override of [
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { metaKey: false, ctrlKey: true },
    { ctrlKey: true },
    { altKey: false },
    { shiftKey: true },
    { code: 'KeyM' },
  ]) {
    await input(page).dispatchEvent('keydown', { ...macKey, ...override });
    expect(await selected(page)).toBe(threadId);
  }
  await input(page).evaluate((element) => {
    element.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  });
  await input(page).dispatchEvent('keydown', macKey);
  expect(await selected(page)).toBe(threadId);
  await input(page).dispatchEvent('compositionstart');
  // This render must not forget the active composition state.
  await input(page).fill('正在组合输入');
  await input(page).dispatchEvent('keydown', macKey);
  expect(await selected(page)).toBe(threadId);
  await input(page).evaluate((element, key) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }),
    );
  }, macKey);
  expect(await selected(page)).toBe(threadId);
  await input(page).dispatchEvent('keyup', macKey);
  // Non-Latin/Option-modified key values still match the physical key after release.
  await input(page).dispatchEvent('keydown', { ...macKey, key: '˜' });
  await expect(input(page)).toBeFocused();
  await expect(page.getByTestId('workspace-start')).toBeVisible();
});

test('dialogs, selectors and Slash suggestions keep focus and the selected conversation', async ({
  page,
}) => {
  await open(page);
  await saveConversationHistory(page);
  const threadId = await selected(page);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加服务器项目', exact: true });
  const projectName = dialog.getByRole('textbox', { name: '项目名称（可选）', exact: true });
  await projectName.fill('弹窗草稿');
  await page.keyboard.press(chord);
  await expect(dialog).toBeVisible();
  await expect(projectName).toBeFocused();
  expect(await selected(page)).toBe(threadId);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const settings = await openSidebarSettings(page);
  await page.keyboard.press(chord);
  await expect(settings).toBeVisible();
  expect(await selected(page)).toBe(threadId);
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  const model = page.getByRole('combobox', { name: '模型', exact: true, includeHidden: true });
  await openModelSettings(page);
  await page.keyboard.press(chord);
  await expect(page.getByRole('dialog', { name: '模型设置', exact: true })).toBeVisible();
  expect(await selected(page)).toBe(threadId);
  await model.click();
  await page.keyboard.press(chord);
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await selected(page)).toBe(threadId);
  await page.keyboard.press('Escape');
  await expect(model).toBeFocused();
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await input(page).fill('/');
  await expect(page.getByRole('listbox', { name: 'Slash 命令' })).toBeVisible();
  await page.keyboard.press(chord);
  await expect(page.getByRole('listbox', { name: 'Slash 命令' })).toBeVisible();
  await expect(input(page)).toHaveValue('/');
  expect(await selected(page)).toBe(threadId);
  await page.keyboard.press('Escape');
  await page.keyboard.press(chord);
  await expect(page.getByTestId('workspace-start')).toBeVisible();
});

test('disabled project and runtime states share the button restrictions', async ({
  page,
  request,
}) => {
  await open(page);
  await saveConversationHistory(page);
  const threadId = await selected(page);
  await controlRuntime(request, { unavailable: true });
  await expect(createThreadButton(page)).toBeDisabled();
  await page.keyboard.press(chord);
  expect(await selected(page)).toBe(threadId);
  await controlRuntime(request, { unavailable: false });
  await confirmCompatibility(page);
  await expect(createThreadButton(page)).toBeEnabled();
  await controlRuntime(request, { version: 'fixture-shortcut-unconfirmed' });
  const compatibility = page.getByRole('dialog', { name: 'Codex 版本兼容性未经验证' });
  await expect(compatibility).toBeVisible();
  await page.keyboard.press(chord);
  await expect(compatibility).toBeVisible();
  expect(await selected(page)).toBe(threadId);
  await confirmCompatibility(page);
  await projectGroup(page, '不可用项目')
    .getByRole('button', { name: '不可用项目', exact: true })
    .click();
  await expect(
    projectGroup(page, '不可用项目').getByRole('button', { name: '新建会话', exact: true }),
  ).toBeDisabled();
  const search = page.getByRole('searchbox', { name: '搜索项目与已加载会话' });
  await search.focus();
  await page.keyboard.press(chord);
  await expect(search).toBeFocused();
});

test('saving defaults and first-message creation block shortcuts until their receipts arrive', async ({
  page,
}) => {
  await open(page);
  let releaseSave!: () => void;
  const saved = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/api/projects/fixture/model-defaults', async (route) => {
    const response = await route.fetch();
    await saved;
    await route.fulfill({ response });
  });
  const search = page.getByRole('searchbox', { name: '搜索项目与已加载会话' });
  try {
    await openModelSettings(page);
    await page
      .getByRole('combobox', { name: '推理强度', exact: true, includeHidden: true })
      .click();
    await page.getByRole('option', { name: 'high', exact: true }).click();
    await expect(createThreadButton(page)).toBeDisabled();
    await search.focus();
    await page.keyboard.press(chord);
    await expect(search).toBeFocused();
  } finally {
    releaseSave();
  }
  await expect(createThreadButton(page)).toBeEnabled();
  let releaseCreate!: () => void;
  const created = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let requests = 0;
  await page.route('**/api/projects/fixture/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++;
    await created;
    await route.continue();
  });
  try {
    await input(page).fill('创建完成前保留草稿 [title-fail]');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(
      projectGroup(page).getByRole('button', { name: '正在创建…', exact: true }),
    ).toBeDisabled();
    await search.focus();
    await page.keyboard.press(chord);
    await expect(search).toBeFocused();
    await expect(input(page)).toHaveValue('创建完成前保留草稿 [title-fail]');
    expect(requests).toBe(1);
  } finally {
    releaseCreate();
  }
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.keyboard.press(chord);
  await expect(input(page)).toBeFocused();
  await expect(page.getByTestId('workspace-start')).toBeVisible();
});

test('unassigned scope and a narrow desktop drawer use the same shortcut', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page
    .getByRole('region', { name: '未关联项目', exact: true })
    .getByRole('button', { name: '新建会话（无需项目）', exact: true })
    .click();
  await input(page).fill('无需项目的草稿');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.keyboard.press(chord);
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue('无需项目的草稿');
  await expect(page.locator('.breadcrumb')).toContainText('未关联项目');
});

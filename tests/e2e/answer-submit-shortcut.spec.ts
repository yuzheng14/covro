import { expect, test, devices, type Page, type Request } from '@playwright/test';
import { parseQuestionReplies } from '../../src/shared/async-questions';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

test.use({ viewport: { width: 1360, height: 1050 } });

const cards = (page: Page) => page.getByRole('region', { name: 'Codex 的提问' });
const nameInput = (page: Page) =>
  cards(page).getByRole('textbox', { name: '项目名称是什么？：自由回答' });
const submit = (page: Page) =>
  cards(page).first().getByRole('button', { name: '发送回答', exact: true });
const isSubmission = (request: Request) =>
  request.method() === 'POST' && /\/api\/threads\/[^/]+\/(turns|steer)$/.test(request.url());

async function open(page: Page, platform = 'MacIntel', prompt = '[async-questions] 确认偏好') {
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, 'platform', { value: platform });
  }, platform);
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(cards(page).first()).toBeVisible();
}

async function flush(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const device of [
  {
    name: 'macOS',
    platform: 'MacIntel',
    chord: 'Meta+Enter',
    hint: '⌘ + Enter',
    aria: 'Meta+Enter',
  },
  {
    name: 'Windows',
    platform: 'Win32',
    chord: 'Control+Enter',
    hint: 'Ctrl + Enter',
    aria: 'Control+Enter',
  },
  {
    name: 'Linux',
    platform: 'Linux x86_64',
    chord: 'Control+Enter',
    hint: 'Ctrl + Enter',
    aria: 'Control+Enter',
  },
]) {
  test(`${device.name} shows its shortcut and submits the same multiline answers as the button`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1360, height: 1050 });
    await open(page, device.platform);
    await cards(page).getByRole('radio', { name: '自由回答', exact: true }).check();
    const theme = cards(page).getByRole('textbox', { name: '界面使用哪种主题？：自由回答' });
    await theme.fill('跟随系统');
    await theme.press('Enter');
    await theme.press('Shift+Enter');
    await expect(theme).toHaveValue('跟随系统\n\n');
    await theme.fill('跟随系统\n允许手动切换');
    await nameInput(page).fill('快捷键测试项目');
    const draft = page.getByRole('textbox', { name: '任务内容', exact: true });
    await draft.fill('稍后发送的主消息草稿');
    await expect(submit(page).locator('kbd')).toHaveText(device.hint);
    await expect(nameInput(page)).toHaveAttribute('aria-keyshortcuts', device.aria);
    await expect(nameInput(page)).toHaveAccessibleDescription(`${device.hint} 发送 / Enter 换行`);
    await submit(page).hover();
    await expect(page.getByRole('tooltip')).toContainText(`${device.hint} 发送 / Enter 换行`);
    await cards(page).screenshot({ path: testInfo.outputPath(`shortcut-${device.name}.png`) });
    await page.mouse.move(0, 0);
    const outgoing = page.waitForRequest(isSubmission);
    await nameInput(page).press(device.chord);
    expect(
      parseQuestionReplies((await outgoing).postDataJSON().text)?.map(({ answer }) => answer),
    ).toEqual(['跟随系统\n允许手动切换', '快捷键测试项目']);
    await expect(cards(page)).toContainText('已发送回答');
    await expect(page.locator('.composer-box textarea')).toHaveValue('稍后发送的主消息草稿');
    await cards(page).screenshot({ path: testInfo.outputPath(`answered-${device.name}.png`) });
  });
}

test('blank or incomplete answers, offline state, newlines and unrelated chords never submit', async ({
  page,
  context,
}, testInfo) => {
  await open(page);
  const input = nameInput(page);
  const outgoing: Request[] = [];
  page.on('request', (request) => {
    if (isSubmission(request)) outgoing.push(request);
  });
  await input.fill(' \n\t');
  await input.press('Meta+Enter');
  await cards(page).getByRole('radio', { name: '自由回答', exact: true }).check();
  await input.fill('仍缺少主题回答');
  await input.press('Meta+Enter');
  await expect(submit(page)).toBeDisabled();
  await cards(page).screenshot({ path: testInfo.outputPath('incomplete.png') });
  await cards(page).getByRole('radio', { name: '浅色', exact: true }).check();
  await input.fill('第一行');
  await input.press('Enter');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('第一行\n\n');
  for (const chord of ['Control+Enter', 'Meta+Shift+Enter', 'Meta+Alt+Enter'])
    await input.press(chord);
  await context.setOffline(true);
  await expect(submit(page)).toBeDisabled();
  await input.press('Meta+Enter');
  await context.setOffline(false);
  await expect(submit(page)).toBeEnabled();
  await input.evaluate((element) => {
    const preventEnter = (event: Event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      event.preventDefault();
      element.removeEventListener('keydown', preventEnter);
    };
    element.addEventListener('keydown', preventEnter);
  });
  await input.press('Meta+Enter');
  await flush(page);
  expect(outgoing).toHaveLength(0);
  await input.press('Meta+Enter');
  await expect(cards(page)).toContainText('已发送回答');
  expect(outgoing).toHaveLength(1);
});

test('IME lifecycle, keyCode 229 and composition-end-adjacent shortcuts do not submit', async ({
  page,
}) => {
  await open(page);
  const input = nameInput(page);
  await input.fill('中文候选词');
  const outgoing: Request[] = [];
  page.on('request', (request) => {
    if (isSubmission(request)) outgoing.push(request);
  });
  await input.dispatchEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', metaKey: true, keyCode: 229 });
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', metaKey: true, isComposing: false });
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush(page);
  expect(outgoing).toHaveLength(0);
  await expect(input).toHaveValue('中文候选词');
  await input.dispatchEvent('keyup', { key: 'Enter' });
  await input.press('Meta+Enter');
  await expect(cards(page)).toContainText('已发送回答');
  expect(outgoing).toHaveLength(1);
});

test('held and duplicate keys dispatch once while sending, and a failed send can be retried', async ({
  page,
}, testInfo) => {
  await open(page);
  await nameInput(page).fill('失败后保留的回答');
  let attempts = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/turns', async (route) => {
    attempts++;
    await delayed;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'THREAD_BUSY', message: '测试发送失败' } },
    });
  });
  await nameInput(page).dispatchEvent('keydown', { key: 'Enter', metaKey: true, repeat: true });
  await flush(page);
  expect(attempts).toBe(0);
  await nameInput(page).evaluate((element) => {
    for (const repeat of [false, false, true])
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
          repeat,
        }),
      );
  });
  await expect(cards(page).getByRole('button', { name: '正在发送…', exact: true })).toBeDisabled();
  await expect(nameInput(page)).toBeDisabled();
  await cards(page).screenshot({ path: testInfo.outputPath('sending.png') });
  expect(attempts).toBe(1);
  release();
  await expect(submit(page)).toBeEnabled();
  await expect(nameInput(page)).toHaveValue('失败后保留的回答');
  await nameInput(page).dispatchEvent('keydown', { key: 'Enter', metaKey: true, repeat: true });
  await flush(page);
  expect(attempts).toBe(1);
  await page.unroute('**/api/threads/*/turns');
  await nameInput(page).press('Meta+Enter');
  await expect(cards(page)).toContainText('已发送回答');
});

test('a shortcut submits only the focused card and preserves another card and the composer draft', async ({
  page,
}) => {
  await open(page, 'MacIntel', '[async-questions-multiple] 多组问题');
  await expect(cards(page)).toHaveCount(2);
  await nameInput(page).fill('第一张卡片的草稿');
  const second = cards(page).last().getByRole('textbox');
  await second.fill('第二张卡片的回答');
  await page.locator('.composer-box textarea').fill('主消息草稿');
  const outgoing = page.waitForRequest(isSubmission);
  await second.press('Meta+Enter');
  const replies = parseQuestionReplies((await outgoing).postDataJSON().text)!;
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ question: '需要哪些补充说明？', answer: '第二张卡片的回答' });
  await expect(cards(page).last()).toContainText('已发送回答');
  await expect(nameInput(page)).toHaveValue('第一张卡片的草稿');
  await expect(submit(page)).toBeEnabled();
  await expect(page.locator('.composer-box textarea')).toHaveValue('主消息草稿');
});

test('a running turn uses the same steer flow as the button', async ({ page }) => {
  await open(page, 'MacIntel', '[async-questions-running] 执行时确认');
  await nameInput(page).fill('执行中的回答');
  const outgoing = page.waitForRequest(isSubmission);
  await nameInput(page).press('Meta+Enter');
  expect((await outgoing).url()).toMatch(/\/steer$/);
  await expect(cards(page)).toContainText('已发送回答');
  await expect(page.locator('.turn')).toHaveCount(1);
  await page.getByRole('button', { name: '中断', exact: true }).click();
});

test.describe('mobile answer input', () => {
  test.use({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: devices['iPhone 13'].viewport,
    isMobile: true,
    hasTouch: true,
  });
  test('mobile keyboard Enter preserves multiline input and only the button submits', async ({
    page,
  }, testInfo) => {
    await open(page, 'iPhone');
    await expect(submit(page).locator('kbd')).toHaveCount(0);
    await nameInput(page).fill('第一行');
    await nameInput(page).press('Enter');
    await nameInput(page).press('Enter');
    await expect(nameInput(page)).toHaveValue('第一行\n\n');
    await expect(nameInput(page)).toHaveAttribute('enterkeyhint', 'enter');
    await expect(nameInput(page)).not.toHaveAttribute('aria-keyshortcuts');
    await nameInput(page).press('Meta+Enter');
    await nameInput(page).press('Control+Enter');
    await expect(cards(page)).not.toContainText('已发送回答');
    await cards(page).screenshot({ path: testInfo.outputPath('mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await submit(page).click();
    await expect(cards(page)).toContainText('已发送回答');
  });
});

import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';
import { parseQuestionReplies } from '../../src/shared/async-questions';

for (const width of [1280, 390]) {
  test(`Markdown questions preserve native answer strings and links at ${width}px`, async ({
    page,
    context,
    request,
  }, testInfo) => {
    await controlRuntime(request, { reset: true });
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto('/');
    await confirmCompatibility(page);
    await createEmptyThread(page);
    await expectThreadReady(page);
    await page.setViewportSize({ width, height: 950 });
    await page
      .getByRole('textbox', { name: '任务内容', exact: true })
      .fill('[async-questions-markdown] 确认部署');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const card = page.locator('.async-question-card');
    await expect(card.locator('.async-question-title strong')).toHaveText('部署环境');
    await expect(card.locator('.async-question-title code')).toHaveText('config.toml');
    await expect(card.locator('.question-option strong')).toHaveText(['预览', '生产']);
    const radios = card.getByRole('radio');
    await expect(radios.nth(0)).toBeChecked();
    await context.route('https://example.com/**', (route) =>
      route.fulfill({ body: 'Deployment guide' }),
    );
    const popup = page.waitForEvent('popup');
    await card.getByRole('link', { name: '部署指南' }).click();
    await (await popup).close();
    await expect(radios.nth(0)).toBeChecked();
    await expect(radios.nth(1)).not.toBeChecked();
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeChecked();
    // The whole non-interactive option surface still selects the native radio.
    await card.locator('.question-option').first().getByText('预览', { exact: true }).click();
    await expect(radios.nth(0)).toBeChecked();
    await card.getByRole('textbox', { name: '项目名称是什么？：自由回答' }).fill('**发布** `v1`');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`questions-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    const sent = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/api\/threads\/[^/]+\/turns$/.test(r.url()),
    );
    await card.getByRole('button', { name: '发送回答', exact: true }).click();
    const replies = parseQuestionReplies((await sent).postDataJSON().text)!;
    expect(replies.map(({ question, answer }) => ({ question, answer }))).toEqual([
      {
        question: '选择 **部署环境**\n\n阅读 `config.toml` 后确认。',
        answer: '**预览**：使用 `staging`',
      },
      { question: '项目名称是什么？', answer: '**发布** `v1`' },
    ]);
    await page.reload();
    await expect(card.locator('.async-question-answer strong')).toHaveText(['预览', '发布']);
    const reply = page.locator('.user-question-reply');
    await expect(reply.first().locator('blockquote strong')).toHaveText('部署环境');
    await expect(reply.last().locator('.user-text code')).toHaveText('v1');
    await expect(card.getByRole('button', { name: '发送回答', exact: true })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`answered-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}

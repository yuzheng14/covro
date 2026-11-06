import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  selectInterfaceLocale,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const indicator = (page: import('@playwright/test').Page) =>
  page.locator('.thread-row:has(.thread-selected) .thread-status-waitingInput');
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
});
async function send(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

for (const [locale, end, ended] of [
  ['zh-Hans', '结束追踪', '已结束追踪 · 未发送回答'],
  ['en', 'End tracking', 'Tracking ended · no answer sent'],
  ['ja', '追跡を終了', '追跡終了 · 回答は未送信'],
  ['ko', '추적 종료', '추적 종료 · 답변 미전송'],
])
  for (const width of [1280, 390]) {
    test(`${locale} tracking entry and history at ${width}px`, async ({ page, request }, info) => {
      await send(page, '[async-questions-multiple] 提问追踪验证');
      await expect(page.locator('.async-question-card')).toHaveCount(2);
      await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
      const id = await page.locator('.thread-selected').getAttribute('data-thread-id');
      const before = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
      if (locale !== 'zh-Hans') await selectInterfaceLocale(page, locale!);
      await page.setViewportSize({ width, height: 1050 });
      const first = page.locator('.async-question-card').first();
      await first.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`entry-${locale}-${width}.png`),
        fullPage: true,
      });
      await first.getByRole('button', { name: end!, exact: true }).first().click();
      await expect(first).toContainText(ended!);
      await expect(first.getByRole('button', { name: end!, exact: true })).toHaveCount(1);
      await first.getByRole('button', { name: end!, exact: true }).click();
      await expect(first.getByRole('button')).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`partial-${locale}-${width}.png`),
        fullPage: true,
      });
      await expect(
        page
          .locator('.async-question-card')
          .last()
          .getByRole('button', { name: end!, exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(first).toContainText(ended!);
      await page
        .locator('.async-question-card')
        .last()
        .getByRole('button', { name: end!, exact: true })
        .click();
      await expect(indicator(page)).toHaveCount(0);
      const after = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
      expect(after.turns.map((turn) => turn.id)).toEqual(before.turns.map((turn) => turn.id));
      expect(after.status).toBe(before.status);
      expect(after.turns[0]?.status).toBe('completed');
      await controlRuntime(request, { restart: true });
      await page.reload();
      await expect(first).toContainText(ended!);
      const compatibility = page.locator('.compatibility-dialog[open]');
      await expect(compatibility).toBeVisible();
      await compatibility.locator('button').last().click();
      await expect(compatibility).toHaveCount(0);
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`ended-${locale}-${width}.png`),
        fullPage: true,
      });
      if (width === 390) {
        await page.locator('.topbar .mobile-only').click();
        await expect(page.locator('.sidebar-open')).toBeVisible();
        await page.screenshot({
          path: info.outputPath(`sidebar-${locale}-${width}.png`),
          fullPage: true,
        });
      }
    });
  }

for (const [locale, skip, submit, skipped] of [
  ['zh-Hans', '跳过此问题', '提交回答与跳过项', '已跳过'],
  ['en', 'Skip this question', 'Submit with skipped questions', 'Skipped'],
  ['ja', 'この質問をスキップ', 'スキップを含めて送信', 'スキップ済み'],
  ['ko', '이 질문 건너뛰기', '건너뛴 질문과 함께 제출', '건너뜀'],
])
  for (const width of [1280, 390]) {
    test(`native ${locale} skip and retained history at ${width}px`, async ({
      page,
      request,
    }, info) => {
      await send(page, '[questions] 原生同步问题');
      if (locale !== 'zh-Hans') await selectInterfaceLocale(page, locale!);
      await page.setViewportSize({ width, height: 1050 });
      const card = page.locator('.pending-actions .action-card');
      await expect(card).toBeVisible();
      await page.screenshot({ path: info.outputPath('native-skip-entry.png'), fullPage: true });
      await card.getByRole('button', { name: skip!, exact: true }).first().click();
      await card.getByRole('textbox').fill('保留此回答');
      const submitted = page.waitForRequest(
        (r) => r.url().includes('/api/actions/') && r.method() === 'POST',
      );
      await card.getByRole('button', { name: submit!, exact: true }).click();
      expect((await submitted).postDataJSON().resolution).toEqual({
        answers: { name: ['保留此回答'] },
        skippedQuestionIds: ['theme'],
      });
      await expect(page.locator('.pending-actions')).toHaveCount(0);
      await expect(page.locator('.turn .action-card')).toContainText(skipped!);
      await expect(page.locator('.turn .action-card')).toContainText('保留此回答');
      await expect(page.locator('.turn .action-card input')).toHaveCount(0);
      await expect(page.locator('.turn-heading .status')).toHaveText(
        locale === 'en'
          ? 'Completed'
          : locale === 'ja'
            ? '完了'
            : locale === 'ko'
              ? '완료'
              : '已完成',
      );
      await controlRuntime(request, { restart: true });
      await page.reload();
      await expect(page.locator('.turn .action-card')).toContainText(skipped!);
      await expect(indicator(page)).toHaveCount(0);
      const compatibility = page.locator('.compatibility-dialog[open]');
      await expect(compatibility).toBeVisible();
      await compatibility.locator('button').last().click();
      await expect(compatibility).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath('native-skip-history.png'), fullPage: true });
    });
  }

test('dismissal failure retains inputs and repeated dismissal does not send an answer', async ({
  page,
}) => {
  await send(page, '[async-questions] 失败与竞态');
  const card = page.locator('.async-question-card');
  await card.getByRole('textbox').fill('保留草稿');
  await page.route('**/questions/dismiss', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'QUESTION_BUSY', message: '回答正在提交' } }),
    }),
  );
  await card.getByRole('button', { name: '结束追踪', exact: true }).first().click();
  await expect(card.getByRole('textbox')).toHaveValue('保留草稿');
  await page.unroute('**/questions/dismiss');
  const id = await page.locator('.thread-selected').getAttribute('data-thread-id');
  const view = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
  const source = view.turns.flatMap((turn) => turn.items).find((item) => item.questions?.length)!;
  const questionIds = source.questions!.map((_, index) =>
    JSON.stringify(['request_user_input_async', source.id, index]),
  );
  const responses = await Promise.all(
    [0, 1].map(() =>
      page.request.post(`/api/threads/${id}/questions/dismiss`, {
        headers: { Origin: new URL(page.url()).origin },
        data: { clientOperationId: randomUUID(), questionIds },
      }),
    ),
  );
  expect(responses.every((r) => r.ok())).toBe(true);
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(indicator(page)).toHaveCount(0);
});

test('remaining answers stay attached after one question ends tracking', async ({ page }) => {
  await send(page, '[async-questions] 部分追踪与部分回答');
  const card = page.locator('.async-question-card');
  await card.getByRole('button', { name: '结束追踪', exact: true }).first().click();
  await card.getByRole('textbox').fill('继续回答这道题');
  await card.getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(card).toContainText('已结束追踪 · 未发送回答');
  await expect(card).toContainText('继续回答这道题');
  await expect(indicator(page)).toHaveCount(0);
  await page.reload();
  await expect(card).toContainText('继续回答这道题');
  await expect(card.getByRole('button')).toHaveCount(0);
});

test('ending async tracking coexists with a running task', async ({ page }) => {
  await send(page, '[async-questions-running] 运行中结束追踪');
  const card = page.locator('.async-question-card');
  await expect(page.locator('.turn-heading .status')).toHaveText('执行中');
  await card.getByRole('button', { name: '结束剩余追踪', exact: true }).click();
  await expect(indicator(page)).toHaveCount(0);
  await expect(page.locator('.turn-heading .status')).toHaveText('执行中');
  await expect(
    page.locator('.thread-row:has(.thread-selected) .thread-status-running'),
  ).toBeVisible();
  await expect(page.locator('.turn')).toHaveCount(1);
});

test('a single native question can be skipped without a replacement turn', async ({
  page,
}, info) => {
  await send(page, '[questions-choice] 跳过单个原生问题');
  const card = page.locator('.pending-actions .action-card');
  await expect(card).toBeVisible();
  const id = await page.locator('.thread-selected').getAttribute('data-thread-id');
  const before = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await card.getByRole('button', { name: '全部跳过并提交', exact: true }).click();
  await expect(page.locator('.pending-actions')).toHaveCount(0);
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(page.locator('.turn .action-card')).toContainText('已跳过');
  const after = (await (await page.request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(after.turns.map((turn) => turn.id)).toEqual(before.turns.map((turn) => turn.id));
  await page.screenshot({ path: info.outputPath('single-skipped.png'), fullPage: true });
});

test('an acknowledged answer awaiting native input keeps accurate tracking through reload', async ({
  page,
}, info) => {
  await send(page, '[async-questions] 等待原生回答入历史');
  const card = page.locator('.async-question-card');
  await card.getByRole('textbox').fill('[pre-turn-compact-hold] 等待确认的回答');
  await card.getByRole('button', { name: '发送回答', exact: true }).click();
  await expect(page.getByTestId('context-compaction')).toHaveAttribute('data-state', 'inProgress');
  await expect(card).toContainText('回答回执待确认');
  await expect(card).not.toContainText('已发送回答');
  await page.screenshot({
    path: info.outputPath('answer-awaiting-confirmation.png'),
    fullPage: true,
  });
  await expect(indicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
  await expect(card.getByRole('button', { name: '结束剩余追踪', exact: true })).toBeDisabled();
  await page.reload();
  await expect(card).toContainText('回答回执待确认');
  await expect(indicator(page)).toHaveAccessibleName('等待回答 · 1 项待处理');
});

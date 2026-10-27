import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  testOrigin,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';
const input = (page: Page) => page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
const dialog = (page: Page) => page.getByRole('dialog', { name: '代码审查目标', exact: true });
async function create(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function choose(page: Page) {
  await input(page).fill('/review');
  await input(page).press('Enter');
  await expect(dialog(page)).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test('native review chooses uncommitted changes, persists results, and sends no prompt', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const id = await create(page);
  const writes: Request[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') writes.push(r);
  });
  await choose(page);
  await page.getByRole('button', { name: '开始审查', exact: true }).click();
  await expect(page.locator('.slash-feedback')).toHaveText(
    '已提交代码审查，请在当前会话查看进度和结果。',
  );
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.getByRole('heading', { name: '代码审查结果', exact: true })).toBeVisible();
  expect(writes.filter((r) => r.url().endsWith('/review'))).toHaveLength(1);
  expect(writes.some((r) => /\/(turns|steer)$/.test(r.url()))).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: '代码审查结果', exact: true })).toBeVisible();
  const history = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(history.turns).toHaveLength(1);
  expect(history.turns[0]!.items.some((i) => i.type === 'userMessage')).toBe(false);
  expect(history.execution).toBeUndefined();
});
test('invalid targets and cancelled or failed submissions preserve the command draft', async ({
  page,
  request,
}) => {
  const id = await create(page);
  const invalid = await request.post(`/api/threads/${id}/review`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), target: { type: 'custom' } },
  });
  expect(invalid.status()).toBe(400);
  await choose(page);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input(page)).toHaveValue('/review');
  await expect(page.locator('.slash-feedback')).toContainText('已取消审查');
  await page.route('**/api/threads/*/review', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'NO_GIT_REPOSITORY', message: '当前目录不是 Git 仓库' } },
    }),
  );
  await choose(page);
  await page.getByRole('button', { name: '开始审查', exact: true }).click();
  await expect(page.locator('.slash-feedback')).toHaveAttribute('role', 'alert');
  await expect(input(page)).toHaveValue('/review');
  await expect(page.getByRole('alert').filter({ hasText: '当前目录不是 Git 仓库' })).toBeVisible();
  expect(
    ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView).turns,
  ).toHaveLength(0);
});
test('blocks a second review while running and interrupts its actual turn', async ({
  page,
  request,
}) => {
  const id = await create(page);
  await page.route('**/api/threads/*/review', async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ response });
  });
  await choose(page);
  await page.getByRole('button', { name: '开始审查', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('执行中');
  await input(page).press('Enter');
  const history = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(
    (
      await request.post(`/api/threads/${id}/interrupt`, {
        headers: { Origin: testOrigin },
        data: { clientOperationId: randomUUID(), expectedTurnId: history.turns[0]!.id },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await expect(input(page)).toHaveValue('');
  expect(
    ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView).turns,
  ).toHaveLength(1);
});
test('selects branch, commit and custom review targets without changing cwd or settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await create(page);
  for (const target of [
    { type: 'baseBranch', branch: 'main' },
    { type: 'commit', sha: 'abcdef123' },
    { type: 'custom', instructions: 'Check concurrency and error handling' },
  ]) {
    const turns = await page.locator('.turn').count();
    await choose(page);
    await dialog(page).getByRole('combobox').selectOption(target.type);
    if ('branch' in target)
      await page.getByRole('textbox', { name: '基础分支', exact: true }).fill(target.branch!);
    if ('sha' in target)
      await page.getByRole('textbox', { name: 'Commit SHA', exact: true }).fill(target.sha!);
    if ('instructions' in target)
      await page.getByRole('textbox', { name: '审查要求', exact: true }).fill(target.instructions!);
    if (target.type === 'baseBranch')
      await page.screenshot({
        path: join(tmpdir(), 'covro-slash-review-desktop.png'),
        fullPage: true,
      });
    const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/review'));
    await page.getByRole('button', { name: '开始审查', exact: true }).click();
    const data = (await posted).postDataJSON();
    expect(data.target).toEqual(target);
    expect(data.cwd).toBeUndefined();
    expect(data.settings).toBeUndefined();
    await expect(page.locator('.turn')).toHaveCount(turns + 1);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(input(page)).toHaveValue('');
  }
});
test('inline review text is a native custom target, and the chooser fits mobile', async ({
  page,
}) => {
  await create(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await input(page).fill('/review Check authorization boundaries');
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/review'));
  await page.getByRole('button', { name: '执行命令', exact: true }).click();
  expect((await posted).postDataJSON().target).toEqual({
    type: 'custom',
    instructions: 'Check authorization boundaries',
  });
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await input(page).fill('/review');
  await page.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('combobox').selectOption('custom');
  await page
    .getByRole('textbox', { name: '审查要求', exact: true })
    .fill('检查手机端状态与错误处理');
  await page.screenshot({ path: join(tmpdir(), 'covro-slash-review-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input(page)).toHaveValue('/review');
});

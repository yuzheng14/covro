import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
  openModelSettings,
  projectGroup,
  testOrigin,
} from './helpers';

const evidence = '/tmp/codex-shadcn-tooltips-evidence';
async function conversation(request: APIRequestContext, text: string) {
  const created = await request.post('/api/projects/fixture/threads', {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()).result as { threadId: string }).threadId;
  const started = await request.post(`/api/threads/${id}/turns`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), text },
  });
  expect(started.ok()).toBe(true);
  return id;
}

test('archive hints cover adjacent icons, stay hoverable, dismiss with Escape and fit narrow screens', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await mkdir(evidence, { recursive: true });
  await page.goto('/');
  await confirmCompatibility(page);
  const older = await conversation(request, '下一个会话 [title-fail]');
  await expect
    .poll(
      async () => (await (await request.get(`/api/threads/${older}`)).json()).turns.at(-1)?.status,
    )
    .toBe('completed');
  const active = await conversation(request, '[approval] 等待批准的会话 [title-fail]');
  await page.goto('/');
  const group = projectGroup(page);
  const row = group
    .locator('.thread-row')
    .filter({ has: page.locator(`[data-thread-id="${active}"]`) });
  const archive = row.getByRole('button', { name: '归档会话', exact: true });
  const popup = page.locator('[data-slot="tooltip-content"]');
  const reason = '任务结束并处理完待办后可归档';
  await expect(archive).toBeDisabled();
  await expect(archive).toHaveAccessibleDescription(reason);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 320) await page.getByRole('button', { name: '打开项目与会话' }).click();
    await archive.hover();
    await expect(popup).toHaveText(reason);
    const hint = (await popup.boundingBox())!;
    expect(hint.x).toBeGreaterThanOrEqual(0);
    expect(hint.x + hint.width).toBeLessThanOrEqual(width);
    expect(hint.y + hint.height).toBeLessThanOrEqual(844);
    const adjacent = (await group
      .locator('.thread-row')
      .filter({ has: page.locator(`[data-thread-id="${older}"]`) })
      .locator('.thread-row-actions')
      .boundingBox())!;
    const x = Math.max(hint.x, adjacent.x) + 2;
    const y = Math.max(hint.y, adjacent.y) + 2;
    expect(x).toBeLessThan(Math.min(hint.x + hint.width, adjacent.x + adjacent.width));
    expect(y).toBeLessThan(Math.min(hint.y + hint.height, adjacent.y + adjacent.height));
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest('[data-slot="tooltip-content"]')),
        { x, y },
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/archive-${width}.png`,
      clip: { x: 0, y: 0, width: 320, height: 844 },
      animations: 'disabled',
    });
    await page.mouse.move(hint.x + hint.width / 2, hint.y + hint.height / 2, { steps: 5 });
    await expect(popup).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await archive.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(archive).toBeFocused();
    await expect(popup).toHaveText(reason);
    await archive.press('Escape');
    await expect(popup).toHaveCount(0);
    await page.mouse.move(0, 0);
  }
  await page.setViewportSize({ width: 320, height: 380 });
  const olderArchive = group
    .locator('.thread-row')
    .filter({ has: page.locator(`[data-thread-id="${older}"]`) })
    .getByRole('button', { name: '归档会话', exact: true });
  await olderArchive.scrollIntoViewIfNeeded();
  await olderArchive.hover();
  await expect(popup).toHaveText('归档会话');
  const edge = (await popup.boundingBox())!;
  expect(edge.y).toBeGreaterThanOrEqual(0);
  expect(edge.y + edge.height).toBeLessThanOrEqual(380);
  expect(
    await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [box.top + 2, box.bottom - 2].every((y) =>
        element.contains(document.elementFromPoint(box.left + box.width / 2, y)),
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/archive-scroll-edge.png`, animations: 'disabled' });
});

test('project, model, permissions and copy hints share dismissal behavior without native title tooltips', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await mkdir(evidence, { recursive: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const popup = page.locator('[data-slot="tooltip-content"]');
  const project = projectGroup(page).locator('.project-link');
  await project.hover();
  await expect(popup).toHaveText('测试项目');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  for (const [label, content] of [
    ['模型', '模型：simulated-model'],
    ['权限模式', '权限模式：只读'],
  ] as const) {
    if (label === '模型') await openModelSettings(page);
    else await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    const select = page.getByRole('combobox', { name: label, exact: true });
    await select.hover();
    await expect(popup).toHaveText(content);
    await page.screenshot({
      path: `${evidence}/${label === '模型' ? 'model' : 'permissions'}.png`,
      animations: 'disabled',
    });
    await select.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(popup).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(select).toBeFocused();
    await expect(popup).toHaveCount(0);
    await page.mouse.move(0, 0);
  }
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[code-copy] 给出代码示例');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const copy = page.getByRole('button', { name: '复制代码块', exact: true }).first();
  await copy.hover();
  await expect(popup).toHaveText('复制代码块');
  await page.screenshot({ path: `${evidence}/code-copy.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.getByRole('button', { name: '复制回答', exact: true }).hover();
  await expect(popup).toHaveText('复制回答（Markdown）');
  await page.screenshot({ path: `${evidence}/reply-copy.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  expect(await page.locator('[title]').count()).toBe(0);
});

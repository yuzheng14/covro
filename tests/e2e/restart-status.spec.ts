import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Operation, ThreadSummaryPage, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  projectGroup,
  testOrigin,
  trackOperationPosts,
} from './helpers';

const headers = { Origin: testOrigin };

async function savedThread(request: APIRequestContext, text: string) {
  const created = await request.post('/api/projects/fixture/threads', {
    headers,
    data: { clientOperationId: crypto.randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const { threadId: id } = ((await created.json()) as Operation).result as { threadId: string };
  const sent = await request.post(`/api/threads/${id}/turns`, {
    headers,
    data: { clientOperationId: crypto.randomUUID(), text },
  });
  expect(sent.ok()).toBe(true);
  return id;
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const mobile of [false, true]) {
  test(`restart keeps completed history out of reconciliation and protects unfinished work (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.goto('/');
    await confirmCompatibility(page);
    const completed = await savedThread(request, '重启前已完成的会话');
    const other = await savedThread(request, '另一条已完成的历史会话');
    const unfinished = await savedThread(request, '[approval] 重启前未结束的任务');
    for (const id of [completed, other])
      await expect
        .poll(
          async () =>
            ((await (await request.get(`/api/threads/${id}`)).json()) as ThreadView).turns.at(-1)
              ?.status,
        )
        .toBe('completed');
    await expect
      .poll(async () =>
        (
          (await (await request.get(`/api/threads/${unfinished}`)).json()) as ThreadView
        ).actions.some((action) => action.status === 'pending'),
      )
      .toBe(true);

    // Stop both the gateway and app-server. Reload real persisted history into a fresh
    // gateway projection, with every upstream thread reporting notLoaded.
    await page.goto('about:blank');
    await controlRuntime(request, { restart: true });
    const listed = await request.get('/api/projects/fixture/threads');
    expect(listed.ok()).toBe(true);
    const summaries = ((await listed.json()) as ThreadSummaryPage).data;
    await page.goto('/');
    await confirmCompatibility(page);
    if (mobile) await page.getByRole('button', { name: '打开项目与会话' }).click();
    await expect(projectGroup(page).getByText('已加载全部会话', { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('restarted-history-list.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.goto('about:blank');
    expect(summaries.find((thread) => thread.id === completed)?.status).toBe('idle');
    expect(summaries.find((thread) => thread.id === other)?.status).toBe('idle');
    expect(summaries.find((thread) => thread.id === unfinished)?.status).toBe('unknown');
    const history = (await (await request.get(`/api/threads/${completed}`)).json()) as ThreadView;
    expect(history.status).toBe('completed');
    expect(history.managed).toBe(false);
    expect(history.execution).toBeUndefined();
    const pending = (await (await request.get(`/api/threads/${unfinished}`)).json()) as ThreadView;
    expect(pending.status).toBe('unknown');
    expect(pending.execution).toMatchObject({ ended: false });

    const posts = trackOperationPosts(page);
    await page.goto('/');
    await page.evaluate((id) => {
      localStorage.setItem('codex-web.project', 'fixture');
      localStorage.setItem('codex-web.selected:fixture', id);
    }, completed);
    await page.reload();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    const input = page.getByRole('textbox', { name: '任务内容', exact: true });
    await input.fill('重启后可以直接继续');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath('completed-history.png'),
      fullPage: true,
      animations: 'disabled',
    });

    if (mobile) await page.getByRole('button', { name: '打开项目与会话' }).click();
    const group = projectGroup(page);
    await expect(group.locator(`[data-thread-id="${other}"]`)).not.toContainText('状态待核对');
    await expect(group.locator(`[data-thread-id="${unfinished}"]`)).toContainText('状态待核对');
    await page.screenshot({
      path: testInfo.outputPath('history-list.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await group.locator(`[data-thread-id="${unfinished}"]`).click();
    await expect(page.locator('.pending-notice')).toBeVisible();
    await input.fill('仍需核对的旧任务');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    expect(posts).toEqual([`${testOrigin}/api/threads/${completed}/resume`]);
    await page.screenshot({
      path: testInfo.outputPath('unfinished-protected.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });
}

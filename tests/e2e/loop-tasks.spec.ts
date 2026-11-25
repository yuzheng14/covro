import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  projectGroup,
  saveConversationHistory,
  testOrigin,
} from './helpers';

const tasks = (page: Page) => page.getByRole('dialog', { name: '后台任务', exact: true });
const composer = (page: Page) => page.locator('.composer-box textarea');

async function openTasks(page: Page) {
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await tasks(page).getByRole('button', { name: '循环任务', exact: true }).click();
  return tasks(page);
}

async function createLoop(page: Page, project: string, title: string, prompt: string) {
  await createEmptyThread(page, project);
  await saveConversationHistory(page);
  const projectId = await projectGroup(page, project).getAttribute('data-project-id');
  const threadId = await page.evaluate(
    (id) => localStorage.getItem(`codex-web.selected:${id}`),
    projectId,
  );
  expect(threadId).toBeTruthy();
  const renamed = await page.request.post(`/api/threads/${threadId}/rename`, {
    data: { clientOperationId: randomUUID(), name: title },
    headers: { Origin: testOrigin },
  });
  expect(renamed.ok()).toBe(true);
  await composer(page).fill(`/loop 1h ${prompt}`);
  await composer(page).press('Enter');
  const dialog = page.getByRole('dialog', { name: '会话循环', exact: true });
  await expect(dialog.locator('.session-loop-row')).toContainText(prompt);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  return threadId!;
}

test('finds and controls cross-project loops from the header, including cold and archived sessions', async ({
  page,
  browser,
  request,
}, info) => {
  test.setTimeout(90_000);
  await controlRuntime(request, { reset: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await confirmCompatibility(page);
  const source = await createLoop(page, '测试项目', '工作台巡检', '汇总工作台的构建结果');
  const target = await createLoop(page, '另一个项目', '发布检查', '检查发布分支的 CI 状态');
  const archived = await createLoop(page, '另一个项目', '文档维护', '检查文档链接');
  expect(
    (
      await page.request.post(`/api/threads/${archived}/archive`, {
        data: { clientOperationId: randomUUID(), archived: true },
        headers: { Origin: testOrigin },
      })
    ).ok(),
  ).toBe(true);

  await controlRuntime(request, { restart: true });
  await page.reload();
  await confirmCompatibility(page);
  const projectOverview = projectGroup(page).getByRole('button', { name: '测试项目', exact: true });
  await projectOverview.click();
  await expect(projectOverview).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.turn')).toHaveCount(0);
  await composer(page).fill('项目概览中的未发送草稿');

  let sent = 0;
  page.on('request', (event) => {
    if (event.method() === 'POST' && /\/turns$/.test(new URL(event.url()).pathname)) sent++;
  });
  const list = await openTasks(page);
  await expect(list.locator('.session-loop-row')).toHaveCount(3);
  const row = list.locator('.session-loop-row').filter({ hasText: '检查发布分支的 CI 状态' });
  await expect(row).toContainText('另一个项目 · 发布检查');
  await expect(row).toContainText('下次');
  const archivedRow = list.locator('.session-loop-row').filter({ hasText: '检查文档链接' });
  await expect(archivedRow).toContainText('会话已归档');
  await expect(archivedRow.getByRole('button', { name: '恢复', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('desktop-project-overview.png') });

  const peer = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  try {
    await peer.goto(testOrigin);
    await (await openTasks(peer)).getByRole('button', { name: /检查发布分支的 CI 状态/ }).click();
    await expect(peer.locator('.topbar h1')).toHaveText('发布检查');
    await expect(peer.locator('.turn')).toHaveCount(1);
    await composer(peer).fill('/loop');
    await composer(peer).press('Enter');
    const peerDialog = peer.getByRole('dialog', { name: '会话循环', exact: true });
    const peerRow = peerDialog.locator('.session-loop-row');
    await expect(peerRow).toContainText('已排程');
    await row.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(row).toContainText('已暂停');
    await expect(row).not.toContainText('下次');
    await expect(peerRow).toContainText('已暂停');
    await peerRow.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(row).toContainText('已排程');
    await expect(peerRow).toContainText('下次');

    // After a committed mutation loses its HTTP response, only the receipt is queried.
    let cancelRequests = 0;
    await page.route(`**/api/threads/${target}/loops/*`, async (route) => {
      if (route.request().postDataJSON()?.action !== 'cancel') return route.continue();
      cancelRequests++;
      const receipt = await route.fetch();
      expect(receipt.ok()).toBe(true);
      await route.abort();
    });
    await row.getByRole('button', { name: '取消循环', exact: true }).click();
    await expect(row).toContainText('已取消');
    await expect(peerRow).toContainText('已取消');
    expect(cancelRequests).toBe(1);
  } finally {
    await peer.close();
  }

  await expect(page.locator('.project-group').getByText('文档维护', { exact: true })).toHaveCount(
    0,
  );
  await archivedRow.getByRole('button', { name: /检查文档链接/ }).click();
  await expect(list).not.toBeVisible();
  await expect(page.locator('.topbar h1')).toHaveText('文档维护');
  await expect(page.locator('.turn')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture-other'))).toBe(
    archived,
  );
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect(composer(page)).toHaveValue('项目概览中的未发送草稿');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('covro.theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.screenshot({ path: info.outputPath('mobile-more-actions.png') });
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await tasks(page).getByRole('button', { name: '循环任务', exact: true }).click();
  await expect(row).toContainText('已取消');
  const mobileRow = list.locator('.session-loop-row').filter({ hasText: '汇总工作台的构建结果' });
  await mobileRow.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(mobileRow).toContainText('已暂停');
  await page.screenshot({ path: info.outputPath('mobile-dark-paused.png') });
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await mobileRow.getByRole('button', { name: /汇总工作台的构建结果/ }).click();
  await expect(page.locator('.topbar h1')).toHaveText('工作台巡检');
  expect(await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'))).toBe(
    source,
  );
  expect(sent).toBe(0);

  for (const [locale, more, background, loops, paused] of [
    ['en', 'More actions', 'Background tasks', 'Loop tasks', 'Paused'],
    ['ja', 'その他の操作', 'バックグラウンドタスク', 'ループタスク', '一時停止中'],
    ['ko', '추가 작업', '백그라운드 작업', '반복 작업', '일시 중지됨'],
  ] as const) {
    await page.evaluate((locale) => localStorage.setItem('covro.locale', locale), locale);
    await page.reload();
    await page.getByRole('button', { name: more, exact: true }).click();
    await page.getByRole('button', { name: background, exact: true }).click();
    const localized = page.getByRole('dialog', { name: background, exact: true });
    await localized.getByRole('button', { name: loops, exact: true }).click();
    await expect(
      localized.locator('.session-loop-row').filter({ hasText: '汇总工作台的构建结果' }),
    ).toContainText(paused);
    await localized.screenshot({ path: info.outputPath(`mobile-dark-${locale}.png`) });
  }
});

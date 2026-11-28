import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

test('renders a streamed HTML visualization in isolation and restores it from history', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('[visualization]');
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/visualization?') && candidate.url().endsWith('training.html'),
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();

  const served = await response;
  expect(served.ok()).toBe(true);
  const policy = served.headers()['content-security-policy'];
  expect(policy).toContain("sandbox allow-scripts; default-src 'none'");
  expect(served.headers()['cache-control']).toBe('private, no-store');

  const reply = page.getByRole('article', { name: 'Codex 的回复' });
  const frame = reply.locator('iframe[title="训练进度"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(reply.locator('.visualization-block[data-wide]')).toBeVisible();
  const preview = frame.contentFrame();
  const train = preview.getByRole('button', { name: '训练 5 轮' });
  await expect(train).toBeVisible();
  expect(await train.evaluate(() => window.origin)).toBe('null');
  await expect(preview.getByText('已训练 0 轮')).toBeVisible();
  await train.click();
  await expect(preview.getByText('已训练 5 轮')).toBeVisible();
  await expect(reply.getByText('无法显示可视化。')).toBeVisible();
  await expect(reply.locator('pre code')).toHaveText(
    '\uE200visualize\uE202{"path":"/example.html"}\uE201',
  );
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await reply.screenshot({ path: testInfo.outputPath('visualization.png') });

  const outsideWorkspace = new URL(served.url());
  outsideWorkspace.searchParams.set('path', '/covro-outside-visualization.html');
  expect((await request.get(outsideWorkspace.toString())).status()).toBe(403);

  await page.reload();
  await expect(train).toBeVisible();
  await train.click();
  await expect(preview.getByText('已训练 5 轮')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reply.screenshot({ path: testInfo.outputPath('visualization-mobile.png') });
});

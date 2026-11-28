import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

test('renders browser completion titles during streaming and in history', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('[browser-completion]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();

  const reply = page.getByRole('article', { name: 'Codex 的回复' });
  const summaries = reply.locator('.browser-completion');
  const titles = ['Confirmed browser connection unavailable', 'Verified the "Settings" page'];
  await expect(summaries).toHaveText(titles);
  await expect(reply.locator('pre code')).toHaveText('::browser-complete{title="Example only"}');

  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page.reload();
  await expect(summaries).toHaveText(titles);
  await expect(reply.locator('pre code')).toHaveText('::browser-complete{title="Example only"}');
  await reply.screenshot({ path: testInfo.outputPath('browser-completion.png') });
});

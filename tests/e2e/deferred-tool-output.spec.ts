import { expect, test } from '@playwright/test';
import type { ItemView, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, createEmptyThread } from './helpers';

test('loads a persisted tool output only after opening the card', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await page.locator('.composer-box textarea').fill('测试按需加载工具输出');
  await page.locator('.composer-box textarea').press('Enter');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const selected = page.locator('[data-thread-id][aria-current="page"]');
  const id = await selected.getAttribute('data-thread-id');
  let reads = 0;
  let saved: ItemView | undefined;
  let sendOutput!: () => void;
  const ready = new Promise<void>((resolve) => {
    sendOutput = resolve;
  });
  await page.route(`**/api/threads/${id}/snapshot`, async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { data: ThreadView };
    for (const turn of snapshot.data.turns) {
      const command = turn.items.find((item) => item.type === 'commandExecution');
      if (!command?.output) continue;
      saved = { ...command };
      command.output = '';
      command.outputDeferred = true;
    }
    await route.fulfill({ response, json: snapshot });
  });
  await page.route(`**/api/threads/${id}/turns/*/items/*`, async (route) => {
    reads++;
    await ready;
    await route.fulfill({ json: saved });
  });

  await page.reload();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const group = page.locator('details.activity-group');
  await group.locator(':scope > summary').click();
  const tool = group.locator('details.activity-command');
  await expect(tool).not.toHaveAttribute('open');
  await expect(tool.locator('.tool-output')).toHaveCount(0);
  expect(reads).toBe(0);
  try {
    await tool.locator(':scope > summary').click();
    await expect(tool.getByRole('status')).toHaveText('读取中…');
    await expect.poll(() => reads).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('tool-output-loading.png') });
  } finally {
    sendOutput();
  }
  await expect(tool.locator('.tool-output')).toHaveText(saved!.output!);
  await page.screenshot({ path: testInfo.outputPath('tool-output-open.png') });
});

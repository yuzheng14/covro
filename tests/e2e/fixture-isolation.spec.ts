import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

test('fixture reset removes active gateway intent as well as native conversation history', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[approval] reset isolation');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await controlRuntime(request, { reset: true });
  const projects = await request.get('/api/threads?projectId=fixture');
  expect((await projects.json()).data).toEqual([]);
  const unassigned = await request.get('/api/unassigned/threads');
  expect((await unassigned.json()).data).toEqual([]);
});

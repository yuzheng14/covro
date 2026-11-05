import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { confirmCompatibility, controlRuntime, projectGroup, testOrigin } from './helpers';

const prompt =
  '[title-fail] 任务：' +
  '修复工作区文件搜索与引用。检查中文、空格、同名文件和多个引用，保留草稿并验证会话切换。'.repeat(
    60,
  );
const unbrokenPrompt = `[title-fail] https://example.test/${'long-path-segment'.repeat(200)}`;

async function conversation(request: APIRequestContext, text: string) {
  const created = await request.post('/api/projects/fixture/threads', {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).result.threadId as string;
  const started = await request.post(`/api/threads/${id}/turns`, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), text },
  });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => (await (await request.get(`/api/threads/${id}`)).json()).turns.at(-1)?.status)
    .toBe('completed');
  return id;
}

test.describe('touch navigation with long fallback titles', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tap switches between conversations after automatic naming fails', async ({
    page,
    request,
  }) => {
    await controlRuntime(request, { reset: true });
    await page.goto('/');
    await confirmCompatibility(page);
    const ids = [await conversation(request, prompt), await conversation(request, unbrokenPrompt)];
    await page.goto('/');
    for (const id of ids) {
      await page.getByRole('button', { name: '打开项目与会话' }).tap();
      await page.locator(`[data-thread-id="${id}"]`).tap();
      await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
      await expect(page.locator('.topbar h1')).toHaveText(id === ids[0] ? prompt : unbrokenPrompt);
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
    }
  });
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 320, height: 380 },
]) {
  test(`long fallback titles stay bounded and allow switching at ${viewport.width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await controlRuntime(request, { reset: true });
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    const ids = [await conversation(request, prompt), await conversation(request, unbrokenPrompt)];
    await page.goto('/');
    const popup = page.locator('[data-slot="tooltip-content"]');

    for (const [index, id] of ids.entries()) {
      if (viewport.width === 320 && !(await page.locator('.sidebar-open').count()))
        await page.getByRole('button', { name: '打开项目与会话' }).click();
      const link = page.locator(`[data-thread-id="${id}"]`);
      const title = index === 0 ? prompt : unbrokenPrompt;
      await expect(link.locator('.thread-title')).toHaveText(title);
      // Keep both rows visible: scrolling only the hovered row can leave its
      // neighbor behind the sticky project heading in a short viewport.
      await page.getByRole('searchbox', { name: '搜索项目与已加载会话' }).fill('[title-fail]');
      const list = projectGroup(page).locator('.thread-list');
      await list.scrollIntoViewIfNeeded();
      await expect(list).toBeInViewport({ ratio: 1 });
      await link.hover();
      await expect(popup).toHaveText(title);
      const screenshot = testInfo.outputPath(`title-hover-${index}.png`);
      await page.screenshot({ path: screenshot, animations: 'disabled' });
      await testInfo.attach(`title-hover-${index}`, { path: screenshot, contentType: 'image/png' });
      const bounds = (await popup.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      const content = popup.locator('.control-hint-content');
      const metrics = await content.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        clipped: element.scrollHeight > element.clientHeight,
      }));
      expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 4 + 1);
      expect(metrics.clipped).toBe(true);
      // The title and neighboring row must receive clicks while the tooltip is open.
      const hits = await page
        .locator(ids.map((id) => `[data-thread-id="${id}"]`).join(','))
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const viewport = element.closest('.project-list')!.getBoundingClientRect();
            return {
              id: element.getAttribute('data-thread-id'),
              receivesClick: element.contains(hit),
              box: box.toJSON(),
              viewport: viewport.toJSON(),
              hit: hit?.outerHTML.slice(0, 300),
            };
          }),
        );
      expect(hits.filter((hit) => !hit.receivesClick)).toEqual([]);
      await link.click();
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.topbar h1')).toHaveText(title);
      if (viewport.width === 320)
        await page.getByRole('button', { name: '打开项目与会话' }).click();
      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await page.keyboard.press('Tab');
      await link.focus();
      await expect(popup).toHaveText(title);
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await link.locator('..').locator('.thread-details-trigger').click();
      await expect(link.locator('..').locator('.thread-details h3')).toHaveText(title);
      await page.keyboard.press('Escape');
    }
  });
}

import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 320, height: 844 },
]) {
  test(`${viewport.name}: shell history truncates long labels and selects output without re-executing`, async ({
    page,
    request,
  }, info) => {
    await controlRuntime(request, { reset: true });
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    if (viewport.name === 'mobile')
      await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '打开 Shell 面板', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Shell 面板' });
    const history = panel.getByRole('combobox', { name: '近期 Shell 命令', exact: true });
    if (viewport.name === 'desktop') {
      await expect(history).toBeDisabled();
      await expect(history).toHaveText('尚未执行');
    }
    let submissions = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/projects\/[^/]+\/shell$/.test(new URL(request.url()).pathname)
      )
        submissions++;
    });
    const first = `printf 'history-${viewport.name}-${'x'.repeat(100)}'`;
    const second = `printf 'second-${viewport.name}'`;
    for (const command of [first, second]) {
      await panel.getByRole('textbox', { name: 'Shell 命令', exact: true }).fill(command);
      await panel.getByRole('button', { name: '执行命令', exact: true }).click();
      await expect(panel.locator('.shell-command-line')).toContainText(command);
      await expect(panel.locator('.shell-result-status')).toContainText('退出码 0');
    }
    await history.click();
    const menu = page.getByRole('listbox');
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: info.outputPath(`history-${viewport.name}-menu.png`) });
    await page.getByRole('option', { name: `已完成 · ${first.slice(0, 70)}`, exact: true }).click();
    await expect(panel.getByLabel('Shell 输出')).toContainText(`history-${viewport.name}`);
    await expect(history).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(submissions).toBe(2);
  });
}

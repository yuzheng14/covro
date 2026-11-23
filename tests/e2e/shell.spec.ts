import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '打开 Shell 面板', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Shell 面板' })).toBeVisible();
});

test('streams a command, reports its exit code and reuses history', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Shell 面板' });
  await page.screenshot({ path: info.outputPath('shell-desktop-open.png') });
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill("printf 'Checking project…\\n'; pwd; sleep 3; printf 'All checks complete.\\n'");
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('Checking project…');
  await expect(panel.getByRole('button', { name: '中断命令', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('shell-desktop-running.png') });
  await expect(panel.locator('.shell-result-status')).toContainText('退出码 0');
  await expect(panel.getByLabel('Shell 输出')).toContainText('All checks complete.');
  await page.screenshot({ path: info.outputPath('shell-desktop-completed.png') });
  await panel.getByRole('button', { name: '复用命令', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Shell 命令', exact: true })).toHaveValue(
    /Checking project/,
  );
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill("printf 'Example failure\\n' >&2; exit 7");
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('Example failure');
  await expect(panel.locator('.shell-result-status')).toContainText('退出码 7');
  await expect(panel.locator('.shell-stderr')).toContainText('Example failure');
});

test('keeps project ownership through collapse, close, navigation and interruption', async ({
  page,
}) => {
  const panel = page.getByRole('region', { name: 'Shell 面板' });
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill("printf 'original project\\n'; sleep 30");
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('original project');
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill('echo original-project-draft');
  await panel.getByRole('button', { name: '收起 Shell', exact: true }).click();
  await expect(panel).toContainText('收起不会停止命令');
  await panel.getByRole('button', { name: '关闭 Shell 面板', exact: true }).click();
  await expect(page.getByLabel('运行中的 Shell 命令')).toHaveText('1');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await page.getByRole('button', { name: '打开 Shell 面板', exact: true }).click();
  await expect(panel.locator('.shell-heading')).toContainText('另一个项目');
  await expect(panel.locator('.shell-location')).toContainText('other-project');
  await expect(panel).toContainText('其他项目仍在执行：测试项目');
  await expect(panel.getByRole('textbox', { name: 'Shell 命令', exact: true })).toHaveValue('');
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Shell 命令', exact: true })).toHaveValue(
    'echo original-project-draft',
  );
  await expect(panel.getByLabel('Shell 输出')).toContainText('original project');
  await panel.getByRole('button', { name: '中断命令', exact: true }).click();
  await expect(panel.locator('.shell-result-status')).toContainText('已中断');
});

test('retains output across browser disconnection and reconnects without re-execution', async ({
  page,
  context,
}) => {
  const panel = page.getByRole('region', { name: 'Shell 面板' });
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill("printf 'before disconnect\\n'; sleep 4; printf 'after reconnect\\n'");
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('before disconnect');
  await context.setOffline(true);
  await expect(panel).toContainText('Shell 连接已断开');
  await expect(panel.getByLabel('Shell 输出')).toContainText('before disconnect');
  await expect(panel.getByRole('button', { name: '中断命令', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(panel).not.toContainText('Shell 连接已断开');
  await expect(panel.getByLabel('Shell 输出')).toContainText('after reconnect');
  await expect(panel.locator('.shell-result-status')).toContainText('退出码 0');
});

test('recovers a lost execution receipt without starting the command twice', async ({
  page,
  request,
}) => {
  const panel = page.getByRole('region', { name: 'Shell 面板' });
  let submissions = 0;
  await page.route('**/api/projects/fixture/shell', async (route) => {
    submissions++;
    await route.fetch();
    await route.abort('failed');
  });
  const command = "printf 'lost receipt recovered\\n'";
  await panel.getByRole('textbox', { name: 'Shell 命令', exact: true }).fill(command);
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('lost receipt recovered');
  await expect(panel.locator('.shell-result-status')).toContainText('退出码 0');
  await expect(panel.getByRole('status').filter({ hasText: '正在核对命令的提交结果' })).toHaveCount(
    0,
  );
  expect(submissions).toBe(1);
  const snapshot = await (await request.get('/api/shell')).json();
  expect(
    snapshot.commands.filter((entry: { command: string }) => entry.command === command),
  ).toHaveLength(1);
});

test('allows command execution in a narrow viewport without horizontal overflow', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole('region', { name: 'Shell 面板' });
  await panel.getByRole('button', { name: '关闭 Shell 面板', exact: true }).click();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  const entry = page.getByRole('button', { name: '打开 Shell 面板', exact: true });
  await expect(entry).toBeInViewport();
  await entry.click();
  await panel
    .getByRole('textbox', { name: 'Shell 命令', exact: true })
    .fill("printf 'Mobile shell ready\\n'; pwd");
  await panel.getByRole('button', { name: '执行命令', exact: true }).click();
  await expect(panel.getByLabel('Shell 输出')).toContainText('Mobile shell ready');
  await expect(panel.locator('.shell-result-status')).toContainText('退出码 0');
  await expect(panel.getByRole('button', { name: '执行命令', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('shell-mobile-completed.png') });
});

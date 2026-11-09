/** Explicit real-browser smoke using an isolated supplied CLI/home and a fresh gateway/project. */
import assert from 'node:assert/strict';
import { CODEX_COMPATIBILITY } from '../src/codex/compatibility.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { CodexAdapter } from '../src/codex/adapter.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';

const args = process.argv.slice(2);
assert(args.includes('--inference'), 'Pass --inference to authorize the isolated model request');
const configIndex = args.indexOf('--config');
const outputIndex = args.indexOf('--output-dir');
assert(configIndex >= 0 && outputIndex >= 0, 'Pass --config and --output-dir');
const { codex: selected } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8'));
assert(selected.home, 'An isolated CODEX_HOME is required');
const output = resolve(args[outputIndex + 1]!);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'covro-native-browser-'));
const project = join(root, 'project');
await mkdir(project);
const config = parseConfig(
  {
    port: 8995,
    publicOrigin: ['http://127.0.0.1:8995'],
    dataDir: join(root, 'data'),
    codex: selected,
    projects: [
      { id: 'native-probe', name: `Codex ${CODEX_COMPATIBILITY.recommended} 验证`, path: project },
    ],
  },
  join(root, 'config.json'),
);
const codex = new CodexAdapter(config.codex);
const runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
const browser = await chromium.launch();
try {
  assert.equal(codex.diagnostics().codexVersion, CODEX_COMPATIBILITY.recommended);
  assert.equal(codex.diagnostics().compatibility, 'verified');
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  await page.goto(config.publicOrigin[0]!);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('Reply exactly CODEX_BROWSER_VERIFIED. Do not call tools or change files.');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成', {
    timeout: 120_000,
  });
  await expect(page.locator('.assistant-message .markdown').last()).toContainText(
    'CODEX_BROWSER_VERIFIED',
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.assistant-message .markdown').last()).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: join(output, `native-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        version: CODEX_COMPATIBILITY.recommended,
        inference: true,
        simulated: false,
        checks: [
          'production frontend + actual gateway + actual CLI',
          'browser task completed with exact reply',
          'desktop and narrow real-page screenshots',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}

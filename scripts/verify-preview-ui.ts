import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { exerciseDevPreview } from '../tests/fixtures/dev-preview-browser.js';
const browser = await chromium.launch({ channel: process.env.PREVIEW_BROWSER_CHANNEL });
const page = await browser.newPage({
  baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}`,
  locale: 'zh-CN',
});
await page.addInitScript(() => {
  if (!localStorage.getItem('covro.locale')) localStorage.setItem('covro.locale', 'zh-Hans');
});
try {
  console.log(
    JSON.stringify(
      {
        kind: 'real-ui-real-vite-fixture-executions',
        screenshots: await exerciseDevPreview(page, resolve('.local/preview-screenshots')),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await mkdir(resolve('.local/preview-screenshots'), { recursive: true });
  await page.screenshot({ path: resolve('.local/preview-screenshots/failure.png') });
  throw error;
} finally {
  await browser.close();
}

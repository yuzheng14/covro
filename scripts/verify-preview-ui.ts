import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { exerciseDevPreview } from '../tests/fixtures/dev-preview-browser.js';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}`,
    locale: 'zh-CN',
  });
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
} finally {
  await browser.close();
}

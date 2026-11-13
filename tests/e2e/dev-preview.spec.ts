import { test } from '@playwright/test';
import { exerciseDevPreview } from '../fixtures/dev-preview-browser';
test('session discovery, independent tabs, policy withdrawal and four-language responsive UI', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await exerciseDevPreview(page);
});

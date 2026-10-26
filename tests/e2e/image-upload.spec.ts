import { expect, test, devices, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createEmptyThread, projectGroup } from './helpers';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const image = { name: 'mobile.png', mimeType: 'image/png', buffer: png };
const input = (page: Page) => page.locator('.composer-box textarea');
const previews = (page: Page) => page.locator('.composer-images img');
const picker = (page: Page) => page.locator('.composer-box input[type=file]');
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
async function choose(page: Page, files = [image]) {
  const opened = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  const chooser = await opened;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(files);
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile touch' : 'desktop'}: select, preview, remove and send images through the native picker`, async ({
    browser,
  }, info) => {
    const context = await browser.newContext(
      mobile
        ? { ...devices['iPhone 13'], locale: 'zh-CN' }
        : { viewport: { width: 1280, height: 900 }, locale: 'zh-CN' },
    );
    const page = await context.newPage();
    await page.goto(info.project.use.baseURL!);
    await confirmCompatibility(page);
    await input(page).fill('请检查这张截图');
    await expect(picker(page)).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/webp,image/gif',
    );
    await choose(page);
    await expect(previews(page)).toHaveCount(1);
    await expect(previews(page)).toHaveJSProperty('naturalWidth', 1);
    await expect(page.locator('.turn')).toHaveCount(0);
    await page.getByRole('button', { name: '移除图片 1' }).click();
    await expect(previews(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue('请检查这张截图');
    await choose(page); // The same file can be selected again.
    await expect(previews(page)).toHaveCount(1);
    await picker(page).dispatchEvent('cancel');
    await expect(input(page)).toHaveValue('请检查这张截图');
    await expect(previews(page)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('attachment-draft.png') });
    const outgoing = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/turns'),
    );
    await send(page).click();
    expect((await outgoing).postDataJSON()).toMatchObject({
      text: '请检查这张截图',
      images: [`data:image/png;base64,${png.toString('base64')}`],
    });
    await expect(previews(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue('');
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(page.locator('.user-message img')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('attachment-sent.png') });
    await context.close();
  });
}

test('invalid types, empty images and shared count/size limits keep the draft intact', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('保留草稿');
  for (const entry of [
    {
      files: [{ name: 'document.pdf', mimeType: 'application/pdf', buffer: png }],
      error: 'PNG、JPEG、WebP 或 GIF',
    },
    { files: [{ ...image, buffer: Buffer.alloc(0) }], error: '图片为空' },
    { files: Array(5).fill(image), error: '最多添加 4 张' },
    {
      files: [{ ...image, buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }],
      error: '总大小不能超过 2 MiB',
    },
  ]) {
    await picker(page).setInputFiles(entry.files);
    await expect(page.locator('.composer-image-error')).toContainText(entry.error);
    await expect(input(page)).toHaveValue('保留草稿');
    await expect(previews(page)).toHaveCount(0);
  }
  await choose(page, Array(4).fill(image));
  await expect(previews(page)).toHaveCount(4);
  await choose(page);
  await expect(page.locator('.composer-image-error')).toContainText('最多添加 4 张');
  await expect(previews(page)).toHaveCount(4);
});

test('a read failure preserves the selected image for retry and blocks sending until ready', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL;
    let fail = true;
    FileReader.prototype.readAsDataURL = function (file) {
      if (!fail) return read.call(this, file);
      fail = false;
      this.dispatchEvent(new ProgressEvent('error'));
    };
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('读取失败也保留');
  await choose(page);
  await expect(page.locator('.composer-image-error')).toContainText('图片读取失败');
  await expect(page.locator('.composer-image-name')).toHaveText('mobile.png');
  await expect(send(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('读取失败也保留');
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(previews(page)).toHaveCount(1);
  await expect(send(page)).toBeEnabled();
  await expect(page.locator('.composer-image-error')).toHaveCount(0);
});

test('a failed send keeps text and attachments and an explicit retry sends them', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await input(page).fill('失败后重试');
  await choose(page);
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'BAD_REQUEST', message: '测试上传失败' } },
    }),
  );
  await send(page).click();
  await expect(page.getByRole('alert').filter({ hasText: '测试上传失败' })).toBeVisible();
  await expect(previews(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('失败后重试');
  await page.unroute('**/api/threads/*/turns');
  await send(page).click();
  await expect(previews(page)).toHaveCount(0);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('slow reads stay with their original project draft and removed images do not return', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL;
    let pending = 0;
    Object.defineProperty(window, 'pendingAttachmentReads', { get: () => pending });
    FileReader.prototype.readAsDataURL = function (file) {
      pending++;
      this.addEventListener('loadend', () => pending--, { once: true });
      setTimeout(() => read.call(this, file), 1200);
    };
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await input(page).fill('第一个项目');
  await choose(page);
  await expect(send(page)).toBeDisabled();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(previews(page)).toHaveCount(0);
  await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).click();
  await expect(previews(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('第一个项目');
  await choose(page);
  await page.getByRole('button', { name: '移除图片 2' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'pendingAttachmentReads')))
    .toBe(0);
  await expect(page.locator('.composer-images li')).toHaveCount(1);
  await expect(previews(page)).toHaveCount(1);
});

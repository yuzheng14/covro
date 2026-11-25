import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ThreadView } from '../../src/shared/types';
import { confirmCompatibility, createThreadButton } from './helpers';

const evidence = '/tmp/codex-local-images-evidence';
const dialog = (page: Page) => page.getByRole('dialog', { name: '图片预览', exact: true });
const thumbnail = (page: Page) => page.locator('img.local-image-thumbnail');

async function send(page: Page, text = '[local-images] 请展示项目进度图') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
}

test.beforeEach(async ({ page, request, baseURL }) => {
  // The fixture control listener always uses the port immediately after the gateway.
  const control = new URL('/runtime', baseURL!);
  control.port = String(Number(control.port) + 1);
  expect((await request.post(control.href, { data: { reset: true } })).ok()).toBe(true);
  await mkdir(evidence, { recursive: true });
  await page.goto('/');
  await confirmCompatibility(page);
  // Request routing disables the browser HTTP cache. Create this fixture through
  // the actual UI so the revalidation tests exercise a normal browser cache.
  await createThreadButton(page).click();
  await send(page, '准备图片预览测试');
  const threadId = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  const assets = join(thread.cwd, 'assets');
  await mkdir(assets, { recursive: true });
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#edf5f0';
    ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = '#1f4b3c';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText('Project progress', 48, 70);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#527060';
    ctx.fillText('Design to delivery · October 2026', 48, 108);
    const rows = [
      ['Design', 1],
      ['Development', 0.8],
      ['Review', 0.6],
      ['Release', 0.35],
    ] as const;
    rows.forEach(([label, value], i) => {
      const y = 160 + i * 84;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(32, y - 20, 896, 72);
      ctx.fillStyle = '#284c3a';
      ctx.font = '22px sans-serif';
      ctx.fillText(label, 54, y + 24);
      ctx.fillStyle = '#e1ebe4';
      ctx.fillRect(280, y, 510, 28);
      ctx.fillStyle = '#4b8b69';
      ctx.fillRect(280, y, 510 * value, 28);
      ctx.fillText(`${Math.round(value * 100)}%`, 824, y + 24);
    });
    return ['image/png', 'image/jpeg', 'image/webp'].map((mime) => canvas.toDataURL(mime));
  });
  await Promise.all(
    ['发布 图表.png', 'preview.jpg', 'preview.webp'].map((name, i) =>
      writeFile(join(assets, name), Buffer.from(images[i]!.split(',')[1]!, 'base64')),
    ),
  );
  await writeFile(
    join(assets, 'preview.gif'),
    Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  );
  await writeFile(join(assets, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(assets, 'broken.png'), 'This is not a PNG image');
  await writeFile(join(assets, 'undecodable.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('local Markdown images and file links load from the gateway and survive reload/reconnect', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 980 });
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/images?')) requests.push(request.url());
  });
  await send(page);
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  await thumbnail(page).scrollIntoViewIfNeeded();
  await screenshot(page, 'desktop-inline');
  expect(
    requests.some((url) => new URL(url).searchParams.get('path') === './assets/发布 图表.png'),
  ).toBe(true);
  const open = page.getByRole('button', { name: '预览图片：项目进度图', exact: true });
  await open.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
  await screenshot(page, 'desktop-preview');
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(dialog(page)).toContainText('125%');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
  await expect(open).toBeFocused();
  for (const name of ['绝对路径图片', '文件 URL 图片', 'JPEG 图片', 'WebP 图片', 'GIF 图片']) {
    await page.getByRole('link', { name, exact: true }).press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('img')).toHaveJSProperty(
      'naturalWidth',
      name === 'GIF 图片' ? 1 : 960,
    );
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  }
  await expect(page.getByRole('link', { name: '普通文件', exact: true })).toHaveAttribute(
    'href',
    /\/api\/threads\/[^/]+\/text\?path=assets%2Fnotes\.txt$/,
  );
  await expect(page.getByRole('link', { name: '外部说明', exact: true })).toHaveAttribute(
    'href',
    'https://example.com/docs',
  );
  await page.reload();
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await open.click();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
});

test('previews reuse fresh images immediately and revalidate stale images in the background', async ({
  page,
  context,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 980 });
  await page.clock.install();
  const expire = async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(new Date(now + 30_001));
  };
  // Playwright's response API exposes the combined 200 response after revalidation.
  // CDP extra-info events expose the actual 304 sent over the network without disabling cache.
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  const imageRequests = new Set<string>();
  const imageUrls = new Set<string>();
  const statuses: number[] = [];
  // Extra-info events can arrive before Chromium identifies the matching request.
  const earlyStatuses = new Map<string, number>();
  network.on('Network.requestWillBeSent', ({ requestId, request: imageRequest }) => {
    const url = new URL(imageRequest.url);
    if (
      url.pathname.endsWith('/images') &&
      url.searchParams.get('path') === './assets/发布 图表.png'
    ) {
      imageRequests.add(requestId);
      const earlyStatus = earlyStatuses.get(requestId);
      if (earlyStatus !== undefined) {
        statuses.push(earlyStatus);
        earlyStatuses.delete(requestId);
      }
      imageUrls.add(imageRequest.url);
    }
  });
  network.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => {
    if (imageRequests.has(requestId)) statuses.push(statusCode);
    else earlyStatuses.set(requestId, statusCode);
  });

  await send(page);
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  await expect.poll(() => statuses).toEqual([200]);
  const open = page.getByRole('button', { name: '预览图片：项目进度图', exact: true });
  const originalSrc = await thumbnail(page).getAttribute('src');
  for (let i = 0; i < 2; i++) {
    await open.click();
    await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
    await expect(dialog(page).locator('img')).toHaveAttribute('src', originalSrc!);
    expect(statuses).toEqual([200]);
    expect(imageRequests.size).toBe(1);
    if (i === 1) await screenshot(page, 'memory-cache-preview');
    await page.keyboard.press('Escape');
  }
  // Even a slow revalidation must not block opening the already-loaded image.
  await network.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 1_500,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await expire();
  await open.click();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
  expect(statuses).toEqual([200]);
  await screenshot(page, 'background-cache-preview');
  await expect.poll(() => statuses).toEqual([200, 304]);
  await page.keyboard.press('Escape');
  await network.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.reload();
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  await expect.poll(() => statuses).toEqual([200, 304, 304]);

  const threadId = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  const imagePath = join(thread.cwd, 'assets/发布 图表.png');
  const updated = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#edf5f0';
    ctx.fillRect(0, 0, 480, 270);
    ctx.fillStyle = '#1f4b3c';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('Updated preview', 48, 140);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await writeFile(imagePath, Buffer.from(updated, 'base64'));
  await expire();
  await open.click();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 480);
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 480);
  await expect.poll(() => statuses).toEqual([200, 304, 304, 200]);
  await screenshot(page, 'http-cache-updated');
  await page.keyboard.press('Escape');
  await open.click();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 480);
  expect(statuses).toEqual([200, 304, 304, 200]);
  await page.keyboard.press('Escape');

  await rm(imagePath);
  await expire();
  await open.click();
  await expect(dialog(page).getByRole('alert')).toContainText('图片文件不存在或已被删除');
  await expect(thumbnail(page)).toHaveCount(0);
  await expect.poll(() => statuses).toEqual([200, 304, 304, 200, 404]);
  await writeFile(imagePath, Buffer.from(updated, 'base64'));
  await dialog(page).getByRole('button', { name: '重试加载图片' }).click();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 480);
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 480);
  await expect.poll(() => statuses).toEqual([200, 304, 304, 200, 404, 200]);
  expect(imageUrls.size).toBe(1);
  await network.detach();
});

test('missing, unsupported and invalid images explain failures and preserve paths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 980 });
  await send(page, '[local-image-errors] 检查图片加载失败的提示');
  const reply = page.getByRole('article', { name: 'Codex 的回复' }).last();
  await expect(reply.getByRole('alert')).toHaveCount(4);
  await expect(reply).toContainText('assets/不存在 截图.png');
  await expect(reply).toContainText('assets/diagram.svg');
  await expect(reply).toContainText('assets/broken.png');
  await expect(reply).toContainText('图片无法解码');
  await reply.scrollIntoViewIfNeeded();
  await screenshot(page, 'desktop-errors');
  await page.getByRole('link', { name: '查看缺失截图', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page)).toContainText('assets/不存在 截图.png');
  await screenshot(page, 'preview-error');
});

test('narrow screens contain thumbnails and a keyboard-operable zoom dialog', async ({ page }) => {
  await send(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  await thumbnail(page).scrollIntoViewIfNeeded();
  expect(
    await thumbnail(page).evaluate((image) => image.getBoundingClientRect().width),
  ).toBeLessThan(390);
  await screenshot(page, 'mobile-inline');
  await page.getByRole('button', { name: '预览图片：项目进度图', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
  await screenshot(page, 'mobile-preview');
  await page.getByRole('button', { name: '放大图片', exact: true }).press('Enter');
  await page.getByRole('button', { name: '适应窗口', exact: true }).press('Enter');
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).press('Enter');
  await expect(dialog(page)).not.toBeVisible();
});

test('server temporary image outputs outside the project support inline and linked previews', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 980 });
  const threadId = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  const directoryName = `codex-local-image-${thread.id}`;
  const systemDirectory = join(tmpdir(), directoryName);
  const posixDirectory = process.platform === 'win32' ? undefined : join('/tmp', directoryName);
  const directories = [...new Set([systemDirectory, ...(posixDirectory ? [posixDirectory] : [])])];
  const systemImage = join(systemDirectory, '临时 图.png');
  const posixImage = posixDirectory ? join(posixDirectory, '临时 图.png') : undefined;
  const bytes = await readFile(join(thread.cwd, 'assets/发布 图表.png'));
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/images?')) requests.push(request.url());
  });
  try {
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all(
      directories.map((directory) => writeFile(join(directory, '临时 图.png'), bytes)),
    );
    const canonicalProject = await realpath(thread.cwd);
    for (const directory of directories) {
      // Prove this exercises the temporary-directory scope rather than project access,
      // including hosts where /tmp resolves to /private/tmp.
      const fromProject = relative(canonicalProject, await realpath(directory));
      expect(
        fromProject === '..' || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject),
      ).toBe(true);
    }
    await send(page, '[local-temp-images] 查看服务器临时图片');
    await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
    expect(requests.some((url) => new URL(url).searchParams.get('path') === systemImage)).toBe(
      true,
    );
    const systemLink = page.getByRole('link', {
      name: '临时文件 URL 图片',
      exact: true,
    });
    await systemLink.press('Enter');
    await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
    await expect(dialog(page).locator('.image-preview-path')).toContainText(systemImage);
    if (posixImage) {
      await page.keyboard.press('Escape');
      await expect(systemLink).toBeFocused();
      const posixLink = page.getByRole('link', {
        name: '标准 tmp 图片',
        exact: true,
      });
      await posixLink.press('Enter');
      await expect(dialog(page).locator('img')).toHaveJSProperty('naturalWidth', 960);
      await expect(dialog(page).locator('.image-preview-path')).toContainText(posixImage);
      expect(requests.some((url) => new URL(url).searchParams.get('path') === posixImage)).toBe(
        true,
      );
    }
    await screenshot(page, 'temporary-preview');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).not.toBeVisible();
    await expect(
      posixImage ? page.getByRole('link', { name: '标准 tmp 图片', exact: true }) : systemLink,
    ).toBeFocused();
    await page.reload();
    await expect(thumbnail(page)).toHaveJSProperty('naturalWidth', 960);
  } finally {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

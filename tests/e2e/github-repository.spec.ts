import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { startGateway } from '../../src/server/main';
import { parseConfig } from '../../src/server/config';
import { DomainCodex, threadView } from '../integration/domain-helpers';
import { git, githubCheckout } from '../helpers/github-repository';

let directory: string;
let origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
const repositoryLink = (page: Page) =>
  page.getByRole('link', { name: '打开 GitHub 仓库', exact: true });
const selectProject = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true }).locator('.project-link').click();

test.beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'covro-github-browser-'));
  const checkout = githubCheckout(
    join(directory, 'checkout'),
    'git@github.com:yuzheng14/covro.git',
  );
  const nested = join(checkout, 'src');
  mkdirSync(nested);
  const other = githubCheckout(
    join(directory, 'other'),
    'https://github.com/example/documentation.git',
  );
  const worktree = join(directory, 'worktree');
  git(other, 'worktree', 'add', '-qb', 'linked', worktree);
  const plain = join(directory, 'plain');
  mkdirSync(plain);
  const ambiguous = githubCheckout(join(directory, 'ambiguous'));
  git(ambiguous, 'remote', 'rename', 'origin', 'fork');
  git(ambiguous, 'remote', 'add', 'upstream', 'git@github.com:another/project.git');
  const conversationDirectory = githubCheckout(
    join(nested, 'conversation'),
    'git@github.com:example/conversation.git',
  );
  const codex = new DomainCodex();
  const thread = threadView('nested-conversation', conversationDirectory);
  thread.title = '会话子目录';
  thread.hasMessages = true;
  codex.threads.set(thread.id, thread);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected local port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(
    {
      port: address.port,
      publicOrigin: [origin],
      dataDir: join(directory, 'data'),
      projects: [
        { id: 'covro', name: 'Covro', path: nested },
        { id: 'docs', name: 'Documentation', path: worktree },
        { id: 'plain', name: '普通目录', path: plain },
        { id: 'ambiguous', name: '多仓库目录', path: ambiguous },
      ],
    },
    join(directory, 'config.json'),
  );
  config.demo = true;
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
});

test.afterEach(async () => {
  await runtime?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('desktop follows project subdirectories, worktrees and conversation cwd and opens a new tab', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin);
  await selectProject(page, 'Covro');
  const link = repositoryLink(page);
  await expect(link).toHaveAttribute('href', 'https://github.com/yuzheng14/covro');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await link.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('github-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await context.route('https://github.com/**', (route) =>
    route.fulfill({ body: 'Repository page' }),
  );
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://github.com/yuzheng14/covro');
  await popup.close();
  await expect(page).toHaveURL(origin);
  await selectProject(page, 'Documentation');
  await expect(link).toHaveAttribute('href', 'https://github.com/example/documentation');
  git(
    join(directory, 'other'),
    'remote',
    'set-url',
    'origin',
    'https://user:secret@github.com/example/updated.git',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(link).toHaveAttribute('href', 'https://github.com/example/updated');
  await page.locator('[data-thread-id="nested-conversation"]').click();
  await expect(link).toHaveAttribute('href', 'https://github.com/example/conversation');
  await selectProject(page, '普通目录');
  await expect(link).toHaveCount(0);
  await selectProject(page, '多仓库目录');
  await expect(link).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('github-hidden-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('mobile keeps the repository action accessible outside the navigation drawer', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await selectProject(page, 'Covro');
  await expect(repositoryLink(page)).toBeVisible();
  await expect(repositoryLink(page)).toHaveAttribute('href', 'https://github.com/yuzheng14/covro');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('github-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await selectProject(page, 'Documentation');
  await expect(repositoryLink(page)).toHaveAttribute(
    'href',
    'https://github.com/example/documentation',
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(repositoryLink(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('late repository responses never replace the newly selected workspace', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let requested!: () => void;
  const started = new Promise<void>((done) => {
    requested = done;
  });
  await page.route('**/api/projects/covro/github-repository', async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: { url: 'https://github.com/yuzheng14/covro' } });
  });
  await page.goto(origin);
  await selectProject(page, 'Covro');
  await started;
  await selectProject(page, 'Documentation');
  await expect(repositoryLink(page)).toHaveAttribute(
    'href',
    'https://github.com/example/documentation',
  );
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(repositoryLink(page)).toHaveAttribute(
    'href',
    'https://github.com/example/documentation',
  );
  await selectProject(page, '普通目录');
  await expect(repositoryLink(page)).toHaveCount(0);
  await page.route('**/api/projects/docs/github-repository', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Unavailable' } },
    }),
  );
  const response = page.waitForResponse('**/api/projects/docs/github-repository');
  await selectProject(page, 'Documentation');
  await response;
  await expect(repositoryLink(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开 Shell 面板' })).toBeEnabled();
});

import { selectInterfaceLocale } from './helpers';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, rm, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';
import { gitCloneFixture } from '../helpers/git-clone';
import Database from 'better-sqlite3';

let directory: string;
let origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let restart: () => Promise<void>;
let previous: Record<string, string | undefined>;
test.beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'covro-clone-browser-')));
  const env = gitCloneFixture(directory);
  previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(
    { port: address.port, publicOrigin: [origin], dataDir: join(directory, 'data') },
    join(directory, 'config.json'),
  );
  config.demo = true;
  const codex = new DomainCodex();
  codex.onStart = (id, turn) => setTimeout(() => codex.complete(id, turn.id), 50);
  restart = async () => {
    runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
  };
  await restart();
});
test.afterEach(async () => {
  await runtime?.close();
  for (const [key, value] of Object.entries(previous ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
async function openAddProject(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 760)
    await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page
    .getByRole('complementary', { name: '项目与会话' })
    .getByRole('button', { name: '添加项目', exact: true })
    .click();
}
async function form(page: Page, repository: string, target = 'project') {
  await openAddProject(page);
  const dialog = page.getByRole('dialog', { name: '添加服务器项目' });
  await dialog.getByRole('button', { name: '克隆 Git 仓库', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Git 仓库地址', exact: true }).fill(repository);
  await dialog
    .getByRole('textbox', { name: '服务器目标目录', exact: true })
    .fill(join(directory, target));
  await dialog.getByRole('textbox', { name: '项目名称（可选）', exact: true }).fill('克隆示例项目');
  return dialog;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('clones and imports a real checkout, opens the project, and protects occupied destinations', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/project.git');
  await screenshot(page, info, 'clone-form-desktop');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
  await screenshot(page, info, 'clone-success-desktop');
  expect(await readFile(join(directory, 'project', 'README.md'), 'utf8')).toBe(
    '# Cloned project\n',
  );
  await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: '克隆示例项目', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('在克隆项目中开始工作');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const conflict = await form(page, 'git@example.test:org/project.git');
  await conflict.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(conflict.getByRole('alert')).toContainText('该目录已添加为项目');
  await screenshot(page, info, 'clone-conflict-desktop');
});

test('shows progress, restores after reload, rejects duplicate requests and cancels on mobile', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  let dialog = await form(page, 'https://example.test/slow.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await screenshot(page, info, 'clone-progress-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const duplicate = await page.request.post(`${origin}/api/project-clones`, {
    headers: { Origin: origin },
    data: {
      clientOperationId: crypto.randomUUID(),
      repository: 'https://example.test/slow.git',
      path: join(directory, 'project'),
    },
  });
  expect(duplicate.status()).toBe(409);
  await page.reload();
  await page.locator('.topbar-more').click();
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await page
    .getByRole('dialog', { name: '后台任务', exact: true })
    .getByRole('button', { name: /克隆示例项目/ })
    .click();
  dialog = page.getByRole('dialog', { name: '添加服务器项目' });
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await dialog.getByRole('button', { name: '取消克隆', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已取消克隆');
  await expect(dialog.getByRole('alert')).toContainText('未添加项目，也未删除任何文件');
  await screenshot(page, info, 'clone-cancelled-mobile');
  expect((await (await page.request.get(`${origin}/api/projects`)).json()).data).toEqual([]);
});

test('shows safe authentication failure and permits retry with another empty directory', async ({
  page,
}, info) => {
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/auth.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆失败');
  await expect(dialog.getByRole('alert')).toContainText('Git 认证失败');
  expect(await dialog.innerText()).not.toMatch(/TOP_SECRET|HIDDEN_TOKEN/);
  await screenshot(page, info, 'clone-auth-failure-desktop');
  await dialog.getByRole('button', { name: '使用空目录重试', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Git 仓库地址', exact: true })
    .fill('ssh://git@example.test/org/project.git');
  await dialog
    .getByRole('textbox', { name: '服务器目标目录', exact: true })
    .fill(join(directory, 'retry'));
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
});

test('offers registration retry without a second clone', async ({ page }, info) => {
  const database = new Database(join(directory, 'data', 'app.sqlite'));
  database.exec(
    "CREATE TRIGGER fail_clone_registration BEFORE INSERT ON project_registrations BEGIN SELECT RAISE(FAIL, 'fixture registration failure'); END",
  );
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/project.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆已完成，项目尚未添加');
  await screenshot(page, info, 'clone-registration-failure-desktop');
  database.exec('DROP TRIGGER fail_clone_registration');
  database.close();
  await dialog.getByRole('button', { name: '重试添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

const localizedProjects = [
  {
    tasks: '后台任务',
    locale: 'zh-Hans',
    browser: 'zh-CN',
    unassigned: '未关联项目',
    add: '添加项目',
    clone: '克隆 Git 仓库',
    repository: 'Git 仓库地址',
    target: '服务器目标目录',
    start: '克隆并添加项目',
    receiving: '正在接收对象 42%',
    cancel: '取消克隆',
    cancelled: '已取消克隆',
    recovery: '未添加项目，也未删除任何文件',
    welcome: '无需选择项目，发送后自动分配独立工作目录；会话和文件将持续保留。',
  },
  {
    tasks: 'Background tasks',
    locale: 'en',
    browser: 'en-US',
    unassigned: 'Unassigned',
    add: 'Add project',
    clone: 'Clone Git repository',
    repository: 'Git repository URL',
    target: 'Destination on server',
    start: 'Clone and add project',
    receiving: 'Receiving objects 42%',
    cancel: 'Cancel clone',
    cancelled: 'Clone cancelled',
    recovery: 'No project was added and no files were deleted.',
    welcome: 'Start without choosing a project.',
  },
  {
    tasks: 'バックグラウンドタスク',
    locale: 'ja',
    browser: 'ja-JP',
    unassigned: 'プロジェクト未関連付け',
    add: 'プロジェクトを追加',
    clone: 'Git リポジトリをクローン',
    repository: 'Git リポジトリの URL',
    target: 'サーバー上の保存先ディレクトリ',
    start: 'クローンしてプロジェクトを追加',
    receiving: 'オブジェクトを受信中 42%',
    cancel: 'クローンをキャンセル',
    cancelled: 'クローンをキャンセルしました',
    recovery: 'プロジェクトの追加もファイルの削除も行っていません。',
    welcome: 'プロジェクトを選ばずに開始できます。',
  },
  {
    tasks: '백그라운드 작업',
    locale: 'ko',
    browser: 'ko-KR',
    unassigned: '프로젝트 미연결',
    add: '프로젝트 추가',
    clone: 'Git 저장소 복제',
    repository: 'Git 저장소 주소',
    target: '서버 대상 디렉터리',
    start: '복제 후 프로젝트 추가',
    receiving: '객체 수신 중 42%',
    cancel: '복제 취소',
    cancelled: '복제가 취소되었습니다',
    recovery: '프로젝트는 추가되지 않았으며 파일도 삭제되지 않았습니다.',
    welcome: '프로젝트를 선택하지 않고 시작할 수 있습니다.',
  },
] as const;
for (const language of localizedProjects) {
  test.describe(`localized projects ${language.locale}`, () => {
    test.use({ locale: language.browser, viewport: { width: 1440, height: 1000 } });
    test('unassigned entry, clone drafts and a running clone survive language changes', async ({
      page,
      context,
    }, info) => {
      const capture = async (state: string) => {
        const path = info.outputPath(`${language.locale}-${state}.png`);
        await page.screenshot({ path, fullPage: true, animations: 'disabled' });
        await info.attach(state, { path, contentType: 'image/png' });
      };
      await page.goto(origin);
      await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
      await expect(
        page.getByRole('region', { name: language.unassigned, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId('workspace-start')).toContainText(language.welcome);
      const draft = '原文草稿 draft 日本語 한국어';
      await page.locator('.composer-box textarea').fill(draft);
      await capture('welcome');
      await page
        .getByRole('complementary')
        .getByRole('button', { name: language.add, exact: true })
        .click();
      const dialog = page.locator('.project-dialog[open]');
      await dialog.getByRole('button', { name: language.clone, exact: true }).click();
      const repository = dialog.getByRole('textbox', { name: language.repository, exact: true });
      await repository.fill('https://example.test/slow.git');
      const target = join(directory, 'localized-project');
      await dialog.getByRole('textbox', { name: language.target, exact: true }).fill(target);
      await capture('clone-form');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await capture('clone-form-mobile');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const peer = await context.newPage();
      await peer.goto(origin);
      const alternate = language.locale === 'en' ? 'ja' : 'en';
      await selectInterfaceLocale(peer, alternate);
      await expect(page.locator('html')).toHaveAttribute('lang', alternate);
      await expect(dialog.locator('input').first()).toHaveValue('https://example.test/slow.git');
      await expect(page.locator('.composer-box textarea')).toHaveValue(draft);
      await selectInterfaceLocale(peer, language.locale);
      await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
      const posted = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/project-clones` &&
          response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: language.start, exact: true }).click();
      const job = (await (await posted).json()) as { id: string };
      await expect(dialog.getByRole('status')).toContainText(language.receiving);
      await selectInterfaceLocale(peer, alternate);
      await expect(page.locator('html')).toHaveAttribute('lang', alternate);
      await expect(dialog.getByRole('status')).toContainText(
        alternate === 'en' ? 'Receiving objects 42%' : 'オブジェクトを受信中 42%',
      );
      const running = await (
        await page.request.get(`${origin}/api/project-clones/${job.id}`)
      ).json();
      expect(running).toMatchObject({
        id: job.id,
        path: target,
        status: 'cloning',
        progressStage: 'receiving',
        percent: 42,
      });
      await selectInterfaceLocale(peer, language.locale);
      await expect(dialog.getByRole('status')).toContainText(language.receiving);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await capture('clone-progress-mobile');
      await dialog.getByRole('button', { name: language.cancel, exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText(language.cancelled);
      await expect(dialog.getByRole('alert')).toContainText(language.recovery);
      await expect(dialog).not.toContainText('covro-message:');
      await expect(page.locator('.composer-box textarea')).toHaveValue(draft);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await capture('clone-cancelled-mobile');
      await page.keyboard.press('Escape');
      await page.locator('.topbar-more').click();
      await page.getByRole('button', { name: language.tasks, exact: true }).click();
      await expect(page.getByRole('dialog', { name: language.tasks, exact: true })).toContainText(
        language.cancelled,
      );
      await capture('task-list-mobile');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await capture('task-list-desktop');
      expect((await (await page.request.get(`${origin}/api/projects`)).json()).data).toEqual([]);
      await peer.close();
    });
  });
}

test('background clone permits chat and session switching; another client restores and completion preserves navigation', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/slow-success.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await expect(dialog.getByRole('button', { name: '关闭项目管理' })).toBeEnabled();
  await screenshot(page, info, 'background-clone-details-desktop');
  await dialog.getByRole('button', { name: '后台运行', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const composer = page.getByRole('textbox', { name: '任务内容', exact: true });
  await composer.fill('克隆在后台继续，先处理当前工作');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const first = await page.locator('.topbar h1').innerText();
  await screenshot(page, info, 'background-clone-chat-desktop');
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '正在接收对象 42%',
  );
  await screenshot(page, info, 'background-task-list-desktop');
  await page
    .getByRole('dialog', { name: '后台任务', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  // Start another conversation, then return to the first while Git is still working.
  await page
    .getByRole('region', { name: '未关联项目', exact: true })
    .getByRole('button', { name: '新建会话（无需项目）', exact: true })
    .click();
  await composer.fill('第二个会话也可以继续');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page
    .getByRole('navigation', { name: '会话历史' })
    .getByRole('button', { name: `${first} · 已完成`, exact: true })
    .click();
  await expect(page.getByText('克隆在后台继续，先处理当前工作', { exact: true })).toBeVisible();
  const current = page.url();
  const peerContext = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
  });
  const peer = await peerContext.newPage();
  await peer.goto(origin);
  await peer.locator('.topbar-more').click();
  await peer.getByRole('button', { name: '后台任务', exact: true }).click();
  await expect(peer.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '正在接收对象 42%',
  );
  await screenshot(peer, info, 'background-task-recovered-mobile');
  await peer.reload();
  await expect(peer.getByRole('dialog')).not.toBeVisible();
  await peer.locator('.topbar-more').click();
  await peer.getByRole('button', { name: '后台任务', exact: true }).click();
  await expect(peer.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '正在接收对象 42%',
  );
  await writeFile(join(directory, 'release'), 'finish');
  await expect(page.locator('.background-task-notice')).toContainText('克隆完成，项目已添加');
  expect(page.url()).toBe(current);
  await expect(page.getByText('克隆在后台继续，先处理当前工作', { exact: true })).toBeVisible();
  await screenshot(page, info, 'background-clone-completed-chat');
  await expect(peer.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '克隆完成，项目已添加',
  );
  await screenshot(peer, info, 'background-clone-completed-mobile');
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
  await page
    .locator('.background-task-notice')
    .getByRole('button', { name: '查看', exact: true })
    .click();
  await expect(dialog.getByRole('button', { name: '打开项目', exact: true })).toBeEnabled();
  await screenshot(page, info, 'background-clone-completed-details');
  await peerContext.close();
});

test('independent clients reconcile cancellation after reconnect and a real isolated service restart', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60_000);
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/slow.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await dialog.getByRole('button', { name: '后台运行', exact: true }).click();
  const peerContext = await browser.newContext({ locale: 'zh-CN' });
  const peer = await peerContext.newPage();
  await peer.goto(origin);
  await peer.getByRole('button', { name: '后台任务', exact: true }).click();
  await peer
    .getByRole('dialog', { name: '后台任务', exact: true })
    .getByRole('button', { name: /克隆示例项目/ })
    .click();
  await page.context().setOffline(true);
  await peer
    .getByRole('dialog')
    .filter({ has: peer.getByRole('button', { name: '取消克隆', exact: true }) })
    .getByRole('button', { name: '取消克隆', exact: true })
    .click();
  await expect(
    peer.getByRole('dialog', { name: '添加服务器项目' }).getByRole('status'),
  ).toContainText('已取消克隆');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '已取消克隆',
  );
  await screenshot(page, info, 'background-task-cancelled-reconnect');
  await page.keyboard.press('Escape');
  const next = await form(page, 'https://example.test/slow.git', 'second');
  await next.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(next.getByRole('status')).toContainText('正在接收对象 42%');
  await next.getByRole('button', { name: '后台运行', exact: true }).click();
  await runtime.close();
  await restart();
  await page.reload();
  await page.getByRole('button', { name: '后台任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务', exact: true })).toContainText(
    '服务中断，克隆结果未确认',
  );
  await screenshot(page, info, 'background-task-service-interrupted');
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(2);
  await peerContext.close();
});

test('reconciles a lost submission response and reports a missing operation without resubmitting', async ({
  page,
}) => {
  await page.goto(origin);
  await page.route('**/api/project-clones', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch(); // The service accepted the clone; only its response is lost.
    await route.abort('failed');
  });
  const dialog = await form(page, 'https://example.test/slow.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await expect(dialog.getByRole('alert')).not.toBeVisible();
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
  await dialog.getByRole('button', { name: '后台运行', exact: true }).click();
  await page.unroute('**/api/project-clones');
  await page.route('**/api/project-clones', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CLONE_FAILED', message: 'fixture failure before acceptance' },
      }),
    });
  });
  const rejected = await form(page, 'https://example.test/project.git', 'rejected');
  await rejected.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(rejected.getByRole('alert')).toContainText('未找到克隆记录');
  await expect(rejected.getByRole('button', { name: '使用空目录重试', exact: true })).toBeEnabled();
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

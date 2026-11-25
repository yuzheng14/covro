import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RestartStatus } from '../../src/shared/service-restart';
import type { Operation, SystemInfo, ThreadView } from '../../src/shared/types';
import { gitCloneFixture } from '../helpers/git-clone';
import { openSidebarSettings, projectGroup, selectInterfaceLocale } from './helpers';

test.skip(!['darwin', 'linux'].includes(process.platform), 'Requires the POSIX Covro CLI');

async function isolatedService() {
  // Keep the root short for the Unix control socket.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cv362-')));
  const project = join(root, 'project');
  const configFile = join(root, 'config.json');
  const bootDelay = join(root, 'delay');
  await mkdir(project);
  const git = gitCloneFixture(root);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const binary = join(root, 'codex');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const options = JSON.stringify({ historyPath: join(root, 'history.json') });
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "app-server" ] && [ -f ${quote(bootDelay)} ]; then sleep 2; fi
exec ${quote(resolve('tests/fixtures/codex.mjs'))} "$@" --options ${quote(options)}
`,
    { mode: 0o700 },
  );
  const config = {
    port,
    publicOrigin: [origin],
    dataDir: join(root, 'data'),
    projects: [{ id: 'fixture', name: 'Restart fixture', path: project }],
    codex: { binary, home: join(root, 'codex-home') },
  };
  await mkdir(config.codex.home);
  await writeFile(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [resolve('bin/covro.mjs'), 'run', '--config', configFile], {
    env: { ...process.env, ...git, COVRO_HOME: join(root, 'app'), CODEX_HOME: config.codex.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => (output += data.toString()));
  child.stderr.on('data', (data: Buffer) => (output += data.toString()));
  const stopped = once(child, 'exit');
  return {
    origin,
    config,
    configFile,
    bootDelay,
    clonePath: join(root, 'clone'),
    cloneRelease: git.COVRO_TEST_GIT_RELEASE,
    output: () => output,
    async logs() {
      const instances = join(root, 'app', 'instances');
      const [key] = await readdir(instances);
      const logs = join(instances, key!, 'logs');
      const files = await readdir(logs);
      const contents = await Promise.all(files.map((file) => readFile(join(logs, file), 'utf8')));
      return contents
        .join('\n')
        .split('\n')
        .filter((line) => /restart\.|daemon\.|codex\./.test(line))
        .slice(-40)
        .join('\n');
    },
    async close() {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function openRestart(page: Page, serviceLabel = '服务配置') {
  const settings = await openSidebarSettings(page, 'service');
  await settings.getByRole('button', { name: serviceLabel, exact: true }).click();
  const control = page.locator('.service-restart');
  await expect(control.getByRole('button').first()).toBeVisible();
  return control;
}

function api(request: APIRequestContext, origin: string) {
  return {
    get: async <T>(path: string): Promise<T> => {
      const response = await request.get(origin + path);
      expect(response.ok()).toBe(true);
      return (await response.json()) as T;
    },
    post: async <T>(path: string, input: object): Promise<T> => {
      const response = await request.post(origin + path, {
        data: input,
        headers: { Origin: origin },
      });
      expect(response.ok()).toBe(true);
      return (await response.json()) as T;
    },
  };
}

test('queues a single restart and restores the selected conversation and unsent draft', async ({
  page,
  request,
}, info) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 1440, height: 980 });
  const instance = await isolatedService();
  const http = api(request, instance.origin);
  const phase = async () => (await http.get<RestartStatus>('/api/service-restart')).run?.phase;
  try {
    await expect
      .poll(async () => (await http.get<SystemInfo>('/api/system').catch(() => undefined))?.ready)
      .toBe(true);
    const before = await http.get<SystemInfo>('/api/system');
    expect((await http.get<{ available?: unknown }>('/api/updates')).available).toBeUndefined();
    const create = async () => {
      const result = await http.post<Operation>('/api/projects/fixture/threads', {
        clientOperationId: randomUUID(),
      });
      expect(result.status).toBe('acknowledged');
      return (result.result as { threadId: string }).threadId;
    };
    const first = await create();
    const second = await create();
    const send = (id: string, text: string) =>
      http.post<Operation>(`/api/threads/${id}/turns`, { clientOperationId: randomUUID(), text });
    const approval = await send(first, '[approval] Restart approval fixture');
    const input = await send(second, '[questions] Restart input fixture');
    const clone = await http.post<{ id: string }>('/api/project-clones', {
      clientOperationId: randomUUID(),
      repository: 'https://example.test/slow-success.git',
      path: instance.clonePath,
    });
    await expect
      .poll(async () => (await http.get<RestartStatus>('/api/service-restart')).blockers)
      .toEqual(expect.arrayContaining(['approval', 'input', 'clone']));

    await page.goto(instance.origin);
    const group = projectGroup(page, 'Restart fixture');
    await group.locator(`[data-thread-id="${first}"]`).click();
    const composer = page.getByRole('textbox', { name: '任务内容', exact: true });
    await composer.fill('未发送的草稿 · Restart fixture');
    const outgoingTurns: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && /\/turns$/.test(outgoing.url()))
        outgoingTurns.push(outgoing.url());
    });

    const control = await openRestart(page);
    await control.screenshot({ path: info.outputPath('01-entry.png') });
    const restartRequest = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/service-restart') && response.request().method() === 'POST',
    );
    await control.getByRole('button', { name: '空闲后重启' }).click({ clickCount: 2 });
    const receipt = (await (await restartRequest).json()) as Operation;
    const restartId = (receipt.result as { restartId: string }).restartId;
    const otherTab = await page.context().newPage();
    const duplicate = await api(otherTab.request, instance.origin).post<Operation>(
      '/api/service-restart',
      {
        clientOperationId: randomUUID(),
        afterId: null,
      },
    );
    expect(duplicate.result).toEqual({ restartId });
    await otherTab.close();
    await expect(control.getByRole('status')).toContainText('等待空闲');
    for (const cause of ['待处理的审批', '待回答的输入', 'Git 克隆'])
      await expect(control.getByRole('status')).toContainText(cause);
    await control.screenshot({ path: info.outputPath('02-waiting.png') });

    // End the two fixture turns explicitly. The queued restart cannot end them on its own.
    for (const [id, op] of [
      [first, approval],
      [second, input],
    ] as const) {
      const expectedTurnId =
        op.execution?.turnId ?? (await http.get<ThreadView>(`/api/threads/${id}`)).turns.at(-1)?.id;
      expect(expectedTurnId).toBeTruthy();
      await http.post<Operation>(`/api/threads/${id}/interrupt`, {
        clientOperationId: randomUUID(),
        expectedTurnId,
      });
    }
    await expect(control.getByRole('status')).toContainText('Git 克隆');
    expect(await phase()).toBe('waiting');
    expect((await http.get<SystemInfo>('/api/system')).codexEpoch).toBe(before.codexEpoch);
    await writeFile(instance.bootDelay, '');
    await writeFile(instance.cloneRelease, '');
    await expect(control.getByRole('status')).toContainText(/重新连接|正在重启/);
    await control.screenshot({ path: info.outputPath('03-reconnecting.png') });
    await expect(control.getByRole('status')).toContainText('Covro 已重启并重新连接', {
      timeout: 25_000,
    });
    expect(await phase()).toBe('succeeded');
    expect((await http.get<SystemInfo>('/api/system')).codexEpoch).not.toBe(before.codexEpoch);
    expect((await http.get<{ status: string }>(`/api/project-clones/${clone.id}`)).status).toBe(
      'completed',
    );
    expect(
      (await http.get<Operation>(`/api/operations/${receipt.clientOperationId}`)).result,
    ).toEqual({ restartId });
    const late = await http.post<Operation>('/api/service-restart', {
      clientOperationId: randomUUID(),
      afterId: null,
    });
    expect(late.result).toEqual({ restartId });
    await page.keyboard.press('Escape');
    await expect(composer).toHaveValue('未发送的草稿 · Restart fixture');
    await expect(
      page.getByText('[approval] Restart approval fixture', { exact: true }),
    ).toBeVisible();
    expect(outgoingTurns).toEqual([]);
    expect((await http.get<ThreadView>(`/api/threads/${first}`)).turns).toHaveLength(1);
    await page.locator('main').screenshot({ path: info.outputPath('04-restored.png') });

    // Changing the listener would strand this browser, so preflight fails in the live process.
    const failedBefore = await http.get<SystemInfo>('/api/system');
    await writeFile(
      instance.configFile,
      JSON.stringify({ ...instance.config, port: instance.config.port + 1 }),
    );
    const failure = await openRestart(page);
    await failure.getByRole('button', { name: '空闲后重启' }).click();
    await expect(failure.getByRole('status')).toContainText('重启失败');
    await expect(failure.getByRole('status')).toContainText('监听地址');
    await failure.screenshot({ path: info.outputPath('05-failed.png') });
    await expect
      .poll(async () => {
        const latest = await http.get<RestartStatus>('/api/service-restart').catch(() => undefined);
        return latest?.run?.failure;
      })
      .toBe('identity');
    expect((await http.get<SystemInfo>('/api/system')).codexEpoch).toBe(failedBefore.codexEpoch);
  } catch (error) {
    if (instance.output())
      await info.attach('isolated-daemon-output', {
        body: instance.output(),
        contentType: 'text/plain',
      });
    const logs = await instance.logs().catch(() => '');
    if (logs) await info.attach('isolated-daemon-logs', { body: logs, contentType: 'text/plain' });
    throw error;
  } finally {
    await instance.close();
  }
});

test('shows the restart entry in every interface language at narrow and desktop widths', async ({
  page,
  request,
}, info) => {
  const instance = await isolatedService();
  try {
    const http = api(request, instance.origin);
    await expect
      .poll(async () => (await http.get<SystemInfo>('/api/system').catch(() => undefined))?.ready)
      .toBe(true);
    await page.goto(instance.origin);
    for (const [locale, serviceLabel, title, width] of [
      ['zh-Hans', '服务配置', '重启 Covro', 320],
      ['en', 'Service settings', 'Restart Covro', 1440],
      ['ja', 'サービス設定', 'Covro を再起動', 390],
      ['ko', '서비스 설정', 'Covro 재시작', 390],
    ] as const) {
      await page.setViewportSize({ width, height: 860 });
      await selectInterfaceLocale(page, locale);
      const control = await openRestart(page, serviceLabel);
      await expect(control.getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await control.screenshot({ path: info.outputPath(`entry-${locale}.png`) });
      await page.keyboard.press('Escape');
    }
  } finally {
    await instance.close();
  }
});

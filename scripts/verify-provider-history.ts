/** Real provider switch and archive/history probe; fresh homes and local model stub only. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';
import { chromium, expect } from '@playwright/test';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';
import { RpcTransport } from '../src/codex/transport.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';

const args = process.argv.slice(2);
const versionIndex = args.indexOf('--expected-version');
const expectedVersion = versionIndex >= 0 ? args[versionIndex + 1]! : '0.169.0';
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const configIndex = args.indexOf('--config');
const outputIndex = args.indexOf('--output-dir');
assert(configIndex >= 0, 'Pass --config selecting an existing target binary');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
const root = await mkdtemp(join(tmpdir(), 'covro-provider-history-'));
let responseId = 0;
const routes: string[] = [];
const bodies: { model?: string }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const title = JSON.stringify(body).includes('Generate a concise');
  // Optional title generation can overlap another session's native model request.
  if (!title) {
    routes.push(request.url ?? '');
    bodies.push(body);
  }
  const id = `provider-${++responseId}`;
  const item = {
    type: 'message',
    id,
    role: 'assistant',
    phase: 'final_answer',
    content: [
      {
        type: 'output_text',
        text: title
          ? JSON.stringify({ title: 'Provider history check' })
          : 'Saved provider history',
      },
    ],
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
async function configure(home: string, provider: string) {
  await writeFile(
    join(home, 'config.toml'),
    `model = "gpt-6.1-sol"\nmodel_provider = "${provider}"\napproval_policy = "never"\ndefault_permissions = ":read-only"\n[features]\nbackground_paginated_rollout_migration = false\n` +
      ['old', 'current']
        .map(
          (id) =>
            `[model_providers.${id}]\nname = "Isolated ${id} provider"\nbase_url = "http://127.0.0.1:${port}/${id}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
        )
        .join(''),
  );
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await stopped;
  clearTimeout(timer);
}
const children: ChildProcessWithoutNullStreams[] = [];
const adapters: CodexAdapter[] = [];
const checks: string[] = [];
try {
  for (const historyMode of ['legacy', 'paginated'] as const) {
    const home = join(root, historyMode);
    const project = join(root, `${historyMode}-project`);
    await mkdir(home);
    await mkdir(project);
    await configure(home, 'old');
    const child = spawn(codex.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stderr.resume();
    const rpc = new RpcTransport(child.stdin, child.stdout);
    const completed = new Set<string>();
    rpc.on('notification', (event: { method: string; params: { turn?: { id: string } } }) => {
      if (event.method === 'turn/completed' && event.params.turn)
        completed.add(event.params.turn.id);
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'codex_web_ui', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    await rpc.notify('initialized');
    const saved = [];
    for (const archived of [false, true]) {
      const { thread } = await rpc.request<ThreadStartResponse>('thread/start', {
        cwd: project,
        historyMode,
      });
      assert.equal(thread.historyMode, historyMode);
      const { turn } = await rpc.request<TurnStartResponse>('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'Save provider history', text_elements: [] }],
      });
      const deadline = Date.now() + 20000;
      while (!completed.has(turn.id)) {
        assert(Date.now() < deadline, 'Provider probe did not complete');
        await new Promise((done) => setTimeout(done, 20));
      }
      if (archived) await rpc.request('thread/archive', { threadId: thread.id });
      saved.push({ id: thread.id, archived });
    }
    await stop(child);
    await configure(home, 'current');
    const adapter = new CodexAdapter({ binary: codex.binary, home });
    adapters.push(adapter);
    await adapter.start();
    assert.equal(adapter.diagnostics().codexVersion, expectedVersion);
    for (const expected of saved) {
      const listed = await adapter.listThreads(project, undefined, expected.archived);
      assert(listed.data.some((thread) => thread.id === expected.id));
      assert.equal(
        (await adapter.listThreads(join(root, 'unrelated'), undefined, expected.archived)).data
          .length,
        0,
      );
      const history = await adapter.readThread(expected.id);
      assert.equal(history.archived, expected.archived);
      assert(
        history.turns.some((turn) =>
          turn.items.some((item) => item.text === 'Saved provider history'),
        ),
      );
      assert.equal((await adapter.readThreadMetadata(expected.id)).archived, expected.archived);
    }
    const events: import('../src/codex/types.js').CodexEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const resumed = await adapter.resumeThread(saved[0]!.id, project);
    assert.equal(resumed.runtimeSettings?.modelCatalog?.provider, 'old');
    assert(
      resumed.runtimeSettings?.modelCatalog?.models.some((model) => model.id === 'gpt-6.1-sol'),
    );
    assert.deepEqual(
      await adapter.saveModelDefaults({
        model: 'gpt-6.1-sol',
        reasoningEffort: 'low',
        modelProvider: 'old',
      }),
      { status: 'threadOnly' },
    );
    async function finishTurn(id: string) {
      const before = routes.length;
      const turn = await adapter.startTurn(id, project, 'Continue with the saved provider', {
        model: 'gpt-6.1-sol',
        reasoningEffort: 'low',
      });
      const deadline = Date.now() + 20000;
      while (
        !events.some(
          (event) =>
            event.type === 'turn' && event.turn.id === turn.id && event.turn.status === 'completed',
        )
      ) {
        assert(Date.now() < deadline, 'Provider continuation did not complete');
        await new Promise((done) => setTimeout(done, 20));
      }
      return routes.slice(before);
    }
    assert((await finishTurn(resumed.id)).every((route) => route.startsWith('/old/')));
    const fresh = await adapter.createThread(project);
    assert.equal(fresh.runtimeSettings?.modelCatalog?.provider, 'current');
    assert((await finishTurn(fresh.id)).every((route) => route.startsWith('/current/')));
    assert(bodies.every((body) => body.model === 'gpt-6.1-sol'));
    checks.push(
      `${historyMode}: switched default preserves old-provider history, archive/cwd boundaries, catalog, successful resume and actual old endpoint; new thread uses current endpoint; foreign selection never rewrites defaults`,
    );
    await adapter.stop();
    if (historyMode === 'paginated' && outputIndex >= 0) {
      const output = resolve(args[outputIndex + 1]!);
      await mkdir(output, { recursive: true });
      const config = parseConfig(
        {
          port: 8997,
          publicOrigin: ['http://127.0.0.1:8997'],
          dataDir: join(root, 'gateway'),
          codex: { binary: codex.binary, home },
          projects: [{ id: 'provider-probe', name: '跨 provider 历史', path: project }],
        },
        join(root, 'gateway.json'),
      );
      const gateway = await startGateway(config, { staticDir: resolve('dist/web') });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 1000 },
          locale: 'zh-CN',
        });
        await page.goto(config.publicOrigin[0]!);
        const active = page.locator(`[data-thread-id="${saved[0]!.id}"]`);
        await expect(active).toBeVisible();
        await active.click();
        await expect(page.locator('.assistant-message .markdown').last()).toContainText(
          'Saved provider history',
        );
        await page.screenshot({
          path: join(output, 'provider-active-history.png'),
          fullPage: true,
        });
        await page.getByRole('button', { name: '模型设置', exact: true }).click();
        await page.getByRole('combobox', { name: '推理强度', exact: true }).click();
        await page.getByRole('option', { name: 'medium', exact: true }).click();
        await expect(page.locator('.settings-defaults')).toHaveText('仅应用于当前会话');
        await page.getByRole('combobox', { name: '模型', exact: true }).click();
        await page.screenshot({
          path: join(output, 'provider-models-desktop.png'),
          fullPage: true,
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '模型设置', exact: true }).click();
        await expect(page.locator('.settings-defaults')).toHaveText('仅应用于当前会话');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(output, 'provider-models-mobile.png'), fullPage: true });
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.getByRole('button', { name: '已归档会话', exact: true }).click();
        await expect(page.locator(`[data-thread-id="${saved[1]!.id}"]`)).toBeVisible();
        await page.screenshot({
          path: join(output, 'provider-archived-history.png'),
          fullPage: true,
        });
        await page.locator('details.diagnostics > summary').click();
        await expect(page.locator('.diagnostics-panel')).toContainText(expectedVersion);
        await page.screenshot({
          path: join(output, 'runtime-version-desktop.png'),
          fullPage: true,
        });
        checks.push(
          'production browser: old-provider active/archived history readable, provider model options and thread-only defaults shown at desktop and 390px without horizontal overflow',
        );
      } finally {
        await browser.close();
        await gateway.close();
      }
    }
  }
  console.log(
    JSON.stringify(
      { version: expectedVersion, inference: false, localStub: true, checks },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(adapters.map((adapter) => adapter.stop()));
  await Promise.all(children.map(stop));
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

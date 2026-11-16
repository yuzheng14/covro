/** Native 0.166.0 error/admission probes. Fresh homes, local HTTP stub, no account or inference. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RpcTransport, CodexError, type RpcNotification } from '../src/codex/transport.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { ThreadReadResponse } from '../src/codex/generated/v2/ThreadReadResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';
import { chromium, expect } from '@playwright/test';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';

const args = process.argv.slice(2);
const versionIndex = args.indexOf('--expected-version');
const expectedVersion = versionIndex >= 0 ? args[versionIndex + 1]! : '0.166.0';
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const configIndex = args.indexOf('--config');
const outputIndex = args.indexOf('--output-dir');
assert(configIndex >= 0, 'Pass --config selecting an isolated target binary');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
assert.equal(
  (await promisify(execFile)(codex.binary, ['--version'])).stdout.trim(),
  `codex-cli ${expectedVersion}`,
);
const root = await mkdtemp(join(tmpdir(), 'covro-166-probes-'));
const children: ReturnType<typeof spawn>[] = [];
const checks: string[] = [];
let failureCode = 'model_not_found';
let requests = 0;
const message = 'Isolated model deployment is unavailable';
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  requests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'probe', status: 'failed', error: { code: failureCode, message } } })}\n\n`,
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
async function configure(home: string, provider = 'probe') {
  await writeFile(
    join(home, 'config.toml'),
    `model = "gpt-6.1-sol"\nmodel_provider = "${provider}"\napproval_policy = "never"\ndefault_permissions = ":read-only"\n[features]\nbackground_paginated_rollout_migration = false\n[model_providers.${provider}]\nname = "Local probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
  );
}
async function start(home: string) {
  const child = spawn(codex.binary, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr.resume();
  const rpc = new RpcTransport(child.stdin, child.stdout);
  const notifications: RpcNotification[] = [];
  rpc.on('notification', (event: RpcNotification) => notifications.push(event));
  rpc.on('request', (request: { id: string | number }) => {
    void rpc.reject(request.id, -32601, 'No approvals in probe');
  });
  await rpc.request('initialize', {
    clientInfo: { name: 'codex_web_ui', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  await rpc.notify('initialized');
  return { rpc, notifications, child };
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done;
  clearTimeout(timer);
}
async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Native error probe timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}
try {
  for (const historyMode of ['legacy', 'paginated'] as const) {
    const home = join(root, historyMode);
    await mkdir(home);
    await configure(home);
    const { rpc, notifications, child } = await start(home);
    let lastThread = '';
    let hookThread = '';
    const failures = [
      ['model_not_found', 'modelNotFound'],
      ['policy_capacity_unavailable', 'policyCapacityUnavailable'],
      ...(expectedVersion === '0.171.0' ? [['bio_policy', 'bioPolicy']] : []),
      ...(['0.169.0', '0.169.1', '0.170.0', '0.171.0'].includes(expectedVersion)
        ? [
            ['inference_hook_denied', 'inferenceHookDenied'],
            ['budget_reached', 'sessionBudgetExceeded'],
          ]
        : []),
    ];
    for (const [code, expected] of failures) {
      failureCode = code!;
      const before = requests;
      const { thread } = await rpc.request<ThreadStartResponse>('thread/start', {
        cwd: root,
        historyMode,
      });
      lastThread = thread.id;
      if (expected === 'inferenceHookDenied') hookThread = thread.id;
      const { turn } = await rpc.request<TurnStartResponse>('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'Probe terminal model failure', text_elements: [] }],
      });
      await wait(() =>
        notifications.some(
          (e) =>
            e.method === 'turn/completed' &&
            (e.params as { turn: { id: string } }).turn.id === turn.id,
        ),
      );
      const live = notifications.findLast((e) => e.method === 'error')!.params as {
        willRetry: boolean;
        error: { codexErrorInfo: string; message: string };
      };
      assert.equal(live.error.codexErrorInfo, expected);
      assert.equal(live.willRetry, false);
      if (expected === 'modelNotFound') assert.equal(live.error.message, message);
      const stored = await rpc.request<ThreadReadResponse>('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(stored.thread.turns.at(-1)?.status, 'failed');
      assert.deepEqual(stored.thread.turns.at(-1)?.error, live.error);
      assert.equal(requests - before, 1, 'Terminal native error must not retry without advice');
      checks.push(`${historyMode}: ${expected} is terminal once and preserved in history`);
    }
    await stop(child);
    if (historyMode === 'paginated' && outputIndex >= 0 && hookThread) {
      const output = resolve(args[outputIndex + 1]!);
      await mkdir(output, { recursive: true });
      const gateway = await startGateway(
        parseConfig(
          {
            port: 8996,
            publicOrigin: ['http://127.0.0.1:8996'],
            dataDir: join(root, 'gateway'),
            codex: { binary: codex.binary, home },
            projects: [{ id: 'terminal-error', name: '终止错误验证', path: root }],
          },
          join(root, 'gateway.json'),
        ),
        { staticDir: resolve('dist/web') },
      );
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 1000 },
          locale: 'zh-CN',
        });
        await page.goto('http://127.0.0.1:8996');
        await page.locator(`[data-thread-id="${hookThread}"]`).click();
        await expect(page.locator('.turn-heading .status').last()).toHaveText('失败');
        await expect(page.locator('.composer-resume-status')).toHaveCount(0);
        await expect(page.getByTestId('capacity-retry-status')).toHaveCount(0);
        await page.screenshot({ path: join(output, 'terminal-error-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(async () => {
            const box = await page.locator('.sidebar').boundingBox();
            return box ? box.x + box.width <= 1 : true;
          })
          .toBe(true);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(output, 'terminal-error-mobile.png'), fullPage: true });
        checks.push(
          'production browser: persisted inferenceHookDenied remains failed without a capacity retry at 1280px and 390px',
        );
      } finally {
        await browser.close();
        await gateway.close();
      }
    }
    await configure(home, 'replacement');
    const restarted = await start(home);
    await assert.rejects(
      restarted.rpc.request('thread/resume', { threadId: lastThread }),
      (error: unknown) => {
        assert(error instanceof CodexError);
        assert.equal(error.code, 'CODEX_REQUEST_FAILED');
        assert.equal(
          (error.details as { modelProviderError?: { type: string } }).modelProviderError?.type,
          'modelProviderNotConfigured',
        );
        return true;
      },
    );
    checks.push(
      `${historyMode}: missing saved provider rejects resume with structured diagnostics`,
    );
    await stop(restarted.child);
  }
  const home = join(root, 'gcp');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), 'model_provider = "gcp"\n');
  const { rpc, child } = await start(home);
  const account = await rpc.request<{ account: { type: string }; requiresOpenaiAuth: boolean }>(
    'account/read',
    { refreshToken: false },
  );
  assert.equal(account.account.type, 'gcp');
  assert.equal(account.requiresOpenaiAuth, false);
  checks.push('GCP account/read works without ChatGPT auth or resolving provider credentials');
  await stop(child);
  console.log(
    JSON.stringify(
      { version: expectedVersion, inference: false, localStub: true, checks },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(children.map(stop));
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

/** Native error and admission probes using fresh homes and a loopback Responses stub. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
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
import type { ErrorNotification } from '../src/codex/generated/v2/ErrorNotification.js';
import type { TurnCompletedNotification } from '../src/codex/generated/v2/TurnCompletedNotification.js';

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
type Failure = { code: string; expected: string; openStream?: 'error' | 'response.failed' };
let failure: Failure | undefined;
let requests = 0;
const message = 'Isolated model deployment is unavailable';
const openResponses = new Set<ServerResponse>();
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  requests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!failure) {
    const item = {
      type: 'message',
      id: 'recovery-answer',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Local recovery completed' }],
    };
    for (const event of [
      { type: 'response.created', response: { id: 'recovery' } },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: { id: 'recovery', status: 'completed', output: [item] },
      },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
    return;
  }
  const error = {
    code: failure.code,
    message,
    ...(failure.openStream ? { headers: { 'Retry-After': '1' } } : {}),
  };
  const event =
    failure.openStream === 'error'
      ? { type: 'error', error }
      : {
          type: 'response.failed',
          response: { id: 'probe', status: 'failed', error },
        };
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (failure.openStream) {
    openResponses.add(response);
    response.once('close', () => openResponses.delete(response));
    response.write(frame);
  } else {
    response.end(frame);
  }
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
    let screenshotThread = '';
    const failures: Failure[] = [
      { code: 'model_not_found', expected: 'modelNotFound' },
      { code: 'policy_capacity_unavailable', expected: 'policyCapacityUnavailable' },
    ];
    if (['0.171.0', '0.172.0'].includes(expectedVersion)) {
      failures.push({ code: 'bio_policy', expected: 'bioPolicy' });
    }
    if (['0.169.0', '0.169.1', '0.170.0', '0.171.0', '0.172.0'].includes(expectedVersion)) {
      failures.push(
        { code: 'inference_hook_denied', expected: 'inferenceHookDenied' },
        { code: 'budget_reached', expected: 'sessionBudgetExceeded' },
      );
    }
    if (expectedVersion === '0.172.0') {
      failures.push(
        { code: 'bio_policy', expected: 'bioPolicy', openStream: 'error' },
        { code: 'cyber_policy', expected: 'cyberPolicy', openStream: 'error' },
        {
          code: 'api_key_spend_limit_exceeded',
          expected: 'apiKeySpendLimitExceeded',
          openStream: 'error',
        },
        {
          code: 'organization_spend_limit_exceeded',
          expected: 'organizationSpendLimitExceeded',
          openStream: 'response.failed',
        },
        {
          code: 'project_spend_limit_exceeded',
          expected: 'projectSpendLimitExceeded',
          openStream: 'error',
        },
      );
    }
    const completed = (turnId: string) =>
      notifications
        .filter((event) => event.method === 'turn/completed')
        .map((event) => event.params as TurnCompletedNotification)
        .find((event) => event.turn.id === turnId)?.turn;
    const persistedFailures: {
      threadId: string;
      turnId: string;
      error: ErrorNotification['error'];
    }[] = [];
    for (const scenario of failures) {
      failure = scenario;
      const { expected, openStream } = scenario;
      const before = requests;
      const { thread } = await rpc.request<ThreadStartResponse>('thread/start', {
        cwd: root,
        historyMode,
        ...(openStream
          ? { config: { model_providers: { probe: { stream_max_retries: 1 } } } }
          : {}),
      });
      lastThread = thread.id;
      if (expected === 'inferenceHookDenied' || expected === 'projectSpendLimitExceeded')
        screenshotThread = thread.id;
      const startTurn = (text: string) =>
        rpc.request<TurnStartResponse>('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text, text_elements: [] }],
        });
      const { turn } = await startTurn('Probe terminal model failure');
      await wait(() => Boolean(completed(turn.id)));
      const live = notifications
        .filter((event) => event.method === 'error')
        .map((event) => event.params as ErrorNotification)
        .filter((event) => event.threadId === thread.id && event.turnId === turn.id);
      assert.equal(live.length, 1, 'Terminal native error must be delivered once');
      const [notification] = live;
      assert(notification);
      assert.equal(notification.error.codexErrorInfo, expected);
      assert.equal(notification.willRetry, false);
      if (expected === 'modelNotFound') assert.equal(notification.error.message, message);
      assert.equal(completed(turn.id)?.status, 'failed');
      assert.deepEqual(completed(turn.id)?.error, notification.error);
      assert.equal(requests - before, 1, 'Terminal native error must not retry');
      persistedFailures.push({ threadId: thread.id, turnId: turn.id, error: notification.error });
      if (openStream) {
        assert.equal(openResponses.size, 0, 'Codex must close the stream without an upstream EOF');
        failure = undefined;
        const next = await startTurn('Probe recovery in the same thread');
        await wait(() => Boolean(completed(next.turn.id)));
        assert.equal(completed(next.turn.id)?.status, 'completed');
        assert.equal(requests - before, 2, 'The next turn makes one new request');
        checks.push(
          `${historyMode}: ${expected} closes a held-open ${openStream} stream despite Retry-After and the next turn succeeds`,
        );
      }
    }
    await stop(child);
    const cold = await start(home);
    for (const { threadId, turnId, error } of persistedFailures) {
      const stored = await cold.rpc.request<ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      });
      const failed = stored.thread.turns.find((turn) => turn.id === turnId);
      assert.equal(failed?.status, 'failed');
      assert.deepEqual(failed.error, error);
      checks.push(
        `${historyMode}: ${error.codexErrorInfo} is terminal once and preserved in cold history`,
      );
    }
    await stop(cold.child);
    if (historyMode === 'paginated' && outputIndex >= 0 && screenshotThread) {
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
        await page.locator(`[data-thread-id="${screenshotThread}"]`).click();
        await expect(page.locator('.turn-heading .status').filter({ hasText: '失败' })).toHaveCount(
          1,
        );
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
          'production browser: persisted terminal error remains failed without a capacity retry at 1280px and 390px',
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

/** Opt-in real-binary regression. Uses a local model stub; no account, inference or existing history. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexAdapter, type AdapterEvent } from '../src/codex/adapter.js';
import { RpcTransport, type RpcNotification } from '../src/codex/transport.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';
import type { ThreadReadResponse } from '../src/codex/generated/v2/ThreadReadResponse.js';
import { renderThreadExport } from '../src/server/thread-export.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const expectedIndex = args.indexOf('--expected-version');
const expectedVersion = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;
assert.match(
  expectedVersion ?? '',
  /^\d+\.\d+\.\d+$/,
  'Pass --expected-version with an exact CLI version',
);
const configIndex = args.indexOf('--config');
if (configIndex < 0) throw new Error('Pass --config with an explicitly selected Codex binary');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
const { stdout } = await promisify(execFile)(codex.binary, ['--version']);
assert.equal(stdout.trim(), `codex-cli ${expectedVersion}`);
const root = await mkdtemp(join(tmpdir(), 'codex-upgrade-'));
const checks: string[] = [];
const report: Record<string, unknown> = {
  codexVersion: stdout.trim(),
  inference: false,
  model: 'local HTTP stub',
  checks,
};
// Mirror the official app-server test server's minimal Responses SSE stream.
let titleRequests = 0;
let rejectModelRequests = false;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  if (rejectModelRequests) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Isolated compaction failure' } }));
    return;
  }
  const isTitle = body.includes('Generate a concise');
  if (isTitle) {
    titleRequests++;
    const tools = (JSON.parse(body) as { tools?: unknown[] }).tools;
    assert.equal(tools?.length ?? 0, 0, 'Title requests must not expose tools');
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = {
    type: 'message',
    id: 'stub-message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: isTitle ? JSON.stringify({ title: '验证升级恢复' }) : 'Saved upgrade check',
      },
    ],
    phase: 'final_answer',
  };
  for (const event of [
    { type: 'response.created', response: { id: 'stub-response' } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'stub-response',
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
const base = `http://127.0.0.1:${address.port}/v1`;
const adapters: CodexAdapter[] = [];
const children: ReturnType<typeof spawn>[] = [];
async function config(
  home: string,
  sandbox: string,
  profileBase = ':workspace',
  model = 'gpt-6.1-sol',
) {
  await writeFile(
    join(home, 'config.toml'),
    `model = "${model}"\nmodel_reasoning_effort = "low"\nservice_tier = "default"\nmodel_provider = "upgrade_stub"\napproval_policy = "never"\ndefault_permissions = ":${sandbox == 'workspace-write' ? 'workspace' : sandbox}"\n[model_providers.upgrade_stub]\nname = "Local upgrade test"\nbase_url = "${base}"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nbackground_paginated_rollout_migration = false\n[permissions.upgrade]\nextends = "${profileBase}"\n`,
  );
}
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for real Codex');
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
try {
  for (const historyMode of ['legacy', 'paginated'] as const) {
    const home = join(root, historyMode);
    const project = join(root, `${historyMode}-project`);
    await mkdir(home);
    await mkdir(project);
    await config(home, 'read-only');
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
    let unexpectedRequest: string | undefined;
    rpc.on('request', (request: { id: string | number; method: string }) => {
      unexpectedRequest = request.method;
      void rpc.reject(request.id, -32601, 'No interactive actions allowed in this test');
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'codex_web_ui_upgrade_check', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    await rpc.notify('initialized');
    const saved = await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: project,
      historyMode,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
    assert.equal(saved.thread.historyMode, historyMode);
    assert.equal(saved.sandbox.type, 'readOnly');
    assert.equal(saved.approvalPolicy, 'on-request');
    const { turn } = await rpc.request<TurnStartResponse>('turn/start', {
      threadId: saved.thread.id,
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      input: [{ type: 'text', text: 'materialize isolated upgrade check', text_elements: [] }],
    });
    await waitUntil(() =>
      notifications.some(
        (event) =>
          event.method === 'turn/completed' &&
          (event.params as { turn: { id: string; status: string } }).turn.id === turn.id,
      ),
    );
    const completion = notifications.findLast((event) => event.method === 'turn/completed')!;
    assert.equal((completion.params as { turn: { status: string } }).turn.status, 'completed');
    // Change settings after the last turn: cold resume must use the saved snapshot,
    // not the earlier turn context or the new global defaults.
    await rpc.request('thread/settings/update', {
      threadId: saved.thread.id,
      model: 'gpt-6-astra',
      effort: 'high',
      serviceTier: 'priority',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
    const profiled = await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: project,
      historyMode,
      permissions: 'upgrade',
      approvalPolicy: 'on-request',
    });
    assert.equal(profiled.sandbox.type, 'workspaceWrite');
    const profileTurn = await rpc.request<TurnStartResponse>('turn/start', {
      threadId: profiled.thread.id,
      input: [{ type: 'text', text: 'persist named profile', text_elements: [] }],
    });
    await waitUntil(() =>
      notifications.some(
        (event) =>
          event.method === 'turn/completed' &&
          (event.params as { turn: { id: string } }).turn.id === profileTurn.turn.id,
      ),
    );
    assert.equal(unexpectedRequest, undefined);
    const persisted = await rpc.request<ThreadReadResponse>('thread/read', {
      threadId: saved.thread.id,
      includeTurns: true,
    });
    const rollout = persisted.thread.path;
    assert(rollout, 'The isolated CLI-created thread must have a persisted rollout');
    await stopChild(child);
    // Only age this test's own file metadata; Codex performs the compression.
    // No rollout contents or database rows are constructed or edited by the test.
    const cold = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(rollout, cold, cold);
    const compressor = spawn(
      codex.binary,
      ['app-server', '--listen', 'stdio://', '-c', 'features.local_thread_store_compression=false'],
      {
        cwd: root,
        env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(compressor);
    compressor.stderr.resume();
    const compressionRpc = new RpcTransport(compressor.stdin, compressor.stdout);
    await compressionRpc.request('initialize', {
      clientInfo: { name: 'codex_web_ui_upgrade_compression', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    await compressionRpc.notify('initialized');
    await compressionRpc.request('rollout/compress', undefined);
    await waitUntil(() => existsSync(`${rollout}.zst`) && !existsSync(rollout));
    const compressed = await compressionRpc.request<ThreadReadResponse>('thread/read', {
      threadId: saved.thread.id,
      includeTurns: true,
    });
    assert.deepEqual(compressed.thread.turns, persisted.thread.turns);
    checks.push(
      `${historyMode}: native rollout/compress and compressed thread/read preserve saved turns`,
    );
    await stopChild(compressor);
    await config(home, 'danger-full-access', ':read-only', 'gpt-5.6-luna');
    const adapter = new CodexAdapter({ binary: codex.binary, home });
    adapters.push(adapter);
    await adapter.start();
    const resumed = await adapter.resumeThread(saved.thread.id, project);
    report[historyMode] = {
      savedTurnSandbox: { type: 'readOnly', networkAccess: true },
      savedApprovalPolicy: 'never',
      resumed: resumed.runtimeSettings,
    };
    assert.equal(resumed.runtimeSettings?.sandbox, 'read-only');
    assert.equal(resumed.runtimeSettings?.approvalPolicy, 'never');
    assert.equal(resumed.runtimeSettings?.networkAccess, true);
    assert.equal(resumed.runtimeSettings?.model, 'gpt-6-astra');
    assert.equal(resumed.runtimeSettings?.reasoningEffort, 'high');
    assert.equal(resumed.runtimeSettings?.serviceTier, 'fast');
    assert.equal(resumed.turns[0]?.status, 'completed');
    assert(renderThreadExport(resumed).markdown.includes('materialize isolated upgrade check'));
    checks.push(
      `${historyMode}: cold resume restores post-turn model, effort, tier, permissions and network access over changed defaults`,
    );
    const contender = new CodexAdapter({ binary: codex.binary, home });
    adapters.push(contender);
    await contender.start();
    await assert.rejects(contender.resumeThread(saved.thread.id, project), {
      code: 'THREAD_IN_USE',
    });
    await adapter.stop();
    const overridden = await contender.resumeThread(saved.thread.id, project, {
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
      serviceTier: null,
    });
    assert.equal(overridden.runtimeSettings?.sandbox, 'read-only');
    assert.equal(overridden.runtimeSettings?.approvalPolicy, 'never');
    assert.equal(overridden.runtimeSettings?.model, 'gpt-6.1-sol');
    assert.equal(overridden.runtimeSettings?.reasoningEffort, 'medium');
    assert.equal(overridden.runtimeSettings?.serviceTier, null);
    checks.push(
      `${historyMode}: exact writer conflict, release, and explicit model/tier/permission overrides`,
    );
    const forked = await contender.forkThread(saved.thread.id, project);
    assert.notEqual(forked.id, saved.thread.id);
    assert.equal(forked.forkedFromId, saved.thread.id);
    assert.deepEqual(
      forked.turns.flatMap((entry) => entry.items.map((item) => item.text)),
      resumed.turns.flatMap((entry) => entry.items.map((item) => item.text)),
    );
    checks.push(`${historyMode}: fork preserves saved messages and parent identity`);
    let title: string | undefined;
    contender.onEvent((event) => {
      if (event.type === 'threadName' && event.threadId === saved.thread.id)
        title = event.name ?? undefined;
    });
    await contender.startTurn(saved.thread.id, project, 'continue isolated upgrade check');
    await waitUntil(() => title === '验证升级恢复');
    assert(titleRequests > 0);
    checks.push(
      `${historyMode}: continuation and automatic title use a tool-free ephemeral thread`,
    );
    const tightened = await contender.resumeThread(profiled.thread.id, project);
    assert.equal(tightened.runtimeSettings?.sandbox, 'read-only');
    assert.deepEqual(tightened.runtimeSettings?.permissionProfile, {
      id: 'upgrade',
      extends: ':read-only',
    });
    let profileTitle: string | undefined;
    contender.onEvent((event) => {
      if (event.type === 'threadName' && event.threadId === profiled.thread.id)
        profileTitle = event.name ?? undefined;
    });
    await contender.startTurn(
      profiled.thread.id,
      project,
      'continue under tightened named profile',
    );
    await waitUntil(() => profileTitle === '验证升级恢复');
    checks.push(
      `${historyMode}: named profile re-resolves tightened config and automatic title preserves its identity`,
    );
    const beforeCompaction = await contender.readThread(profiled.thread.id);
    const compactionEvents: AdapterEvent[] = [];
    const unsubscribe = contender.onEvent((event) => compactionEvents.push(event));
    rejectModelRequests = true;
    await contender.compactThread(profiled.thread.id);
    await waitUntil(() =>
      compactionEvents.some(
        (event) =>
          event.type === 'turn' &&
          event.threadId === profiled.thread.id &&
          event.turn.status === 'failed',
      ),
    );
    rejectModelRequests = false;
    const afterCompaction = await contender.readThread(profiled.thread.id);
    const messages = (thread: typeof afterCompaction) =>
      thread.turns.flatMap((turn) =>
        turn.items
          .filter((item) => item.type === 'userMessage' || item.type === 'agentMessage')
          .map((item) => item.text),
      );
    assert.deepEqual(messages(afterCompaction), messages(beforeCompaction));
    const continued = await contender.startTurn(
      profiled.thread.id,
      project,
      'continue after failed compaction',
    );
    await waitUntil(() =>
      compactionEvents.some(
        (event) =>
          event.type === 'turn' &&
          event.turn.id === continued.id &&
          event.turn.status === 'completed',
      ),
    );
    unsubscribe();
    checks.push(
      `${historyMode}: failed compaction preserves messages without partial summaries and allows continuation`,
    );
    await contender.stop();
  }
  const layerHome = join(root, 'layer-home');
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const childProject = join(projectA, 'child');
  await mkdir(layerHome);
  for (const path of [projectA, projectB]) {
    await mkdir(path);
    await promisify(execFile)('git', ['init', '--quiet', path]);
  }
  await mkdir(join(projectA, '.codex'));
  await mkdir(join(childProject, '.codex'), { recursive: true });
  await writeFile(join(projectA, '.codex/config.toml'), 'model = "gpt-5.6-luna"\n');
  await writeFile(join(childProject, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
  await config(layerHome, 'read-only');
  const layerConfig = join(layerHome, 'config.toml');
  await writeFile(
    layerConfig,
    (await readFile(layerConfig, 'utf8')) +
      `\n[projects.${JSON.stringify(projectA)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(projectB)}]\ntrust_level = "trusted"\n`,
  );
  const layered = new CodexAdapter({ binary: codex.binary, home: layerHome });
  adapters.push(layered);
  await layered.start();
  assert.equal((await layered.readRuntimeSettings(projectA)).model, 'gpt-5.6-luna');
  assert.equal((await layered.readRuntimeSettings(childProject)).model, 'gpt-6-astra');
  assert.equal((await layered.readRuntimeSettings(projectB)).model, 'gpt-6.1-sol');
  checks.push(
    'config/read uses explicit cwd across projects and nested trusted configuration, independent of app-server launch cwd',
  );
  await layered.stop();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await Promise.all(adapters.map((adapter) => adapter.stop()));
  await Promise.all(children.map(stopChild));
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  if (args.includes('--keep')) report.root = root;
  else await rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0)
    await writeFile(resolve(args[outputIndex + 1]!), JSON.stringify(report, null, 2) + '\n');
}

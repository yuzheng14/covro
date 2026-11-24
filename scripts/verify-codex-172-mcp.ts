/** Verify app-tool reviewer configuration and cached stdio MCP on the exact target CLI. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcTransport, type RpcNotification } from '../src/codex/transport.js';
import type { AppToolsConfig } from '../src/codex/generated/v2/AppToolsConfig.js';
import type { ConfigReadResponse } from '../src/codex/generated/v2/ConfigReadResponse.js';
import type { McpServerStatusUpdatedNotification } from '../src/codex/generated/v2/McpServerStatusUpdatedNotification.js';
import type { McpServerToolCallResponse } from '../src/codex/generated/v2/McpServerToolCallResponse.js';
import type { ThreadStartParams } from '../src/codex/generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnCompletedNotification } from '../src/codex/generated/v2/TurnCompletedNotification.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';

const binary = process.argv[2];
assert(binary, 'Pass the path to an existing Codex 0.172.0 binary');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli 0.172.0');

const root = await mkdtemp(join(tmpdir(), 'covro-172-mcp-'));
const childEvents = join(root, 'mcp-events');
const fixture = join(root, 'local-mcp.mjs');
const home = join(root, 'home');
const checks: string[] = [];
await mkdir(home);
await writeFile(childEvents, '');
await writeFile(
  fixture,
  `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.argv[2];
appendFileSync(log, 'start\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === 'initialize') {
    result = {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'local-stdio-probe', version: '1.0.0' }
    };
  } else if (method === 'tools/list') {
    appendFileSync(log, 'list\\n');
    result = { tools: [{ name: 'echo', inputSchema: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text']
    } }] };
  } else if (method === 'tools/call' && params.name === 'echo') {
    appendFileSync(log, 'call\\n');
    result = { content: [{ type: 'text', text: params.arguments.text }] };
  } else if (method === 'ping') {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(result
    ? { result }
    : { error: { code: -32601, message: 'Unknown probe method' } }) }) + '\\n');
}
`,
);
const modelInput = 'Complete without calling tools';
let modelRequests = 0;
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  if (request.url !== '/v1/responses' || !raw) {
    response.writeHead(404).end();
    return;
  }
  if (raw.includes(modelInput)) modelRequests++;
  const item = {
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    id: 'local-result',
    content: [{ type: 'output_text', text: 'Catalog checked locally' }],
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'local-response' } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'local-response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const address = model.address();
assert(address && typeof address !== 'string');
const config = [
  'approval_policy = "never"',
  'default_permissions = ":read-only"',
  'model = "gpt-6.1-sol"',
  'model_provider = "local_probe"',
  '[model_providers.local_probe]',
  'name = "Local MCP verification"',
  `base_url = "http://127.0.0.1:${address.port}/v1"`,
  'wire_api = "responses"',
  'requires_openai_auth = false',
  'request_max_retries = 0',
  'stream_max_retries = 0',
  '[mcp_servers.stdio_probe]',
  `command = ${JSON.stringify(process.execPath)}`,
  `args = ${JSON.stringify([fixture, childEvents])}`,
  'startup_timeout_sec = 8',
  '[apps.local_probe.tools.manual]',
  'approvals_reviewer = "user"',
  '[apps.local_probe.tools.automatic]',
  'approvals_reviewer = "auto_review"',
  '[apps.local_probe.tools.inherited]',
  'enabled = true',
].join('\n');
await writeFile(join(home, 'config.toml'), config);
const child = spawn(resolve(binary), ['app-server', '--listen', 'stdio://'], {
  cwd: root,
  env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
const rpc = new RpcTransport(child.stdin, child.stdout);
const ready = new Set<string>();
const completed = new Map<string, TurnCompletedNotification['turn']['status']>();
rpc.on('notification', (event: RpcNotification) => {
  if (event.method === 'turn/completed') {
    const { turn } = event.params as TurnCompletedNotification;
    completed.set(turn.id, turn.status);
  }
  if (event.method !== 'mcpServer/startupStatus/updated') return;
  const status = event.params as McpServerStatusUpdatedNotification;
  if (status.threadId && status.name === 'stdio_probe' && status.status === 'ready')
    ready.add(status.threadId);
});
rpc.on('request', (event: { id: string | number }) => {
  void rpc.reject(event.id, -32601, 'Unexpected approval for local probe');
});
const events = async () => (await readFile(childEvents, 'utf8')).trim().split('\n').filter(Boolean);
const starts = async () => (await events()).filter((event) => event === 'start').length;
async function until(test: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!test()) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
const threadReady = (threadId: string) => until(() => ready.has(threadId), 'native MCP readiness');
const open = async (overrides?: ThreadStartParams['config']) =>
  (
    await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: root,
      ...(overrides ? { config: overrides } : {}),
    })
  ).thread.id;
async function echo(threadId: string) {
  const answer = await rpc.request<McpServerToolCallResponse>('mcpServer/tool/call', {
    threadId,
    server: 'stdio_probe',
    tool: 'echo',
    arguments: { text: 'local-stdio-response' },
  });
  assert.equal(answer.isError ?? false, false);
  assert.deepEqual(answer.content, [{ type: 'text', text: 'local-stdio-response' }]);
}

try {
  await rpc.request('initialize', {
    clientInfo: { name: 'codex_web_ui', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  await rpc.notify('initialized');
  const effective = await rpc.request<ConfigReadResponse>('config/read', { cwd: root });
  const apps = effective.config.apps as { local_probe?: { tools?: AppToolsConfig } } | null;
  assert.deepEqual(apps?.local_probe?.tools, {
    manual: { enabled: null, approval_mode: null, approvals_reviewer: 'user' },
    automatic: { enabled: null, approval_mode: null, approvals_reviewer: 'auto_review' },
    inherited: { enabled: true, approval_mode: null, approvals_reviewer: null },
  });
  checks.push(
    'config/read retains explicit manual and automatic tool reviewers and a null default',
  );

  const cold = await open();
  await threadReady(cold);
  assert.equal(await starts(), 1);
  assert((await events()).includes('list'), 'Cold discovery must populate the real catalog cache');
  const lazy = await open();
  const { turn } = await rpc.request<TurnStartResponse>('turn/start', {
    threadId: lazy,
    input: [{ type: 'text', text: modelInput, text_elements: [] }],
  });
  await until(() => completed.has(turn.id), 'the turn that leaves the tool unused');
  assert.equal(completed.get(turn.id), 'completed');
  assert.equal(modelRequests, 1, 'The loopback model must receive the unused-tool turn');
  assert.equal(ready.has(lazy), false);
  assert.equal(await starts(), 1, 'A turn using a warm catalog must not start an unused server');
  await echo(lazy);
  await threadReady(lazy);
  assert.equal(await starts(), 2);
  assert.equal((await events()).filter((event) => event === 'call').length, 1);
  checks.push(
    'warm optional stdio stays dormant through a turn and connects on the first tool call',
  );

  const eager = await open({ features: { mcp_lazy_stdio_startup: false } });
  await threadReady(eager);
  assert.equal(await starts(), 3, 'Disabling lazy startup must open a live connection');
  const required = await open({ mcp_servers: { stdio_probe: { required: true } } });
  await threadReady(required);
  assert.equal(await starts(), 4, 'Required stdio server must open a live connection');
  assert.equal((await events()).filter((event) => event === 'call').length, 1);
  checks.push('opt-out and required servers connect eagerly with a warm catalog');
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
  console.log(JSON.stringify({ version: '0.172.0', inference: false, checks }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    await done;
    clearTimeout(kill);
  }
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

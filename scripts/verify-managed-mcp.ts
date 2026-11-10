/** Opt-in real Codex check: fresh home, local model stub, no account or remote inference. */
import assert from 'node:assert/strict';
import { CODEX_COMPATIBILITY } from '../src/codex/compatibility.js';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { startGateway } from '../src/server/main.js';
import { parseConfig } from '../src/server/config.js';

const args = process.argv.slice(2);
const binaryIndex = args.indexOf('--binary');
assert(
  binaryIndex >= 0 && args[binaryIndex + 1],
  'Pass --binary selecting an existing verified Codex installation',
);
const binary = resolve(args[binaryIndex + 1]!);
const root = await realpath(await mkdtemp(join(tmpdir(), 'covro-mcp-native-')));
const home = join(root, 'home');
const source = join(root, 'source');
const target = join(root, 'target');
await Promise.all([home, source, target].map((path) => mkdir(path)));
const checks: string[] = [];
const fired = new Set<string>();
const outputs: string[] = [];
let nextId = 1;
let modelFailure: Error | undefined;
let allowCreation = false;
let approvals = 0;
const model = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      input?: { type: string; [key: string]: unknown }[];
      tools?: unknown[];
    };
    const input = JSON.stringify(body.input);
    for (const item of body.input ?? [])
      if (item.type === 'custom_tool_call_output') outputs.push(JSON.stringify(item));
    const title = input.includes('Generate a concise');
    const task = JSON.stringify(body.input?.filter((item) => item.role === 'user').at(-1));
    const recap = task.includes('covro-mcp-probe-recap');
    if (title || recap) assert.equal(body.tools?.length ?? 0, 0);
    const phase = task.includes('covro-mcp-probe-denied')
      ? 'denied'
      : task.includes('covro-mcp-probe-parent')
        ? 'parent'
        : task.includes('covro-mcp-probe-restart')
          ? 'restart'
          : task.includes('covro-mcp-probe-external')
            ? 'external'
            : '';
    let item: Record<string, unknown>;
    if (!title && phase && !fired.has(phase)) {
      fired.add(phase);
      const find = 'const all = ALL_TOOLS.filter(t => /^mcp__covro_[a-f0-9]{32}__/.test(t.name));';
      const code =
        phase === 'external'
          ? `${find} if (all.length) throw new Error('External process unexpectedly received Covro tools'); text('external-no-covro');`
          : `${find} const list = all.find(t => t.name.endsWith('__list_projects')); if (!list) throw new Error('Missing Covro projects tool'); text(await tools[list.name]({})); ${phase === 'parent' || phase === 'denied' ? "const create = all.find(t => t.name.endsWith('__create_session')); text(await tools[create.name]({project_id:'target',prompt:'covro-mcp-probe-child'}));" : ''}`;
      item = {
        type: 'custom_tool_call',
        id: `ctc_${nextId++}`,
        call_id: `call_${nextId++}`,
        name: 'exec',
        namespace: 'functions',
        input: code,
      };
    } else {
      item = {
        type: 'message',
        id: `msg_${nextId++}`,
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: recap
              ? JSON.stringify({ summary: 'Local MCP recap verification complete.' })
              : title
                ? JSON.stringify({ title: 'MCP verification' })
                : 'Local MCP verification complete.',
          },
        ],
        phase: 'final_answer',
      };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `response_${nextId}` } },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: `response_${nextId}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) {
    modelFailure = error as Error;
    response.writeHead(500);
    response.end();
  }
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const modelAddress = model.address();
assert(modelAddress && typeof modelAddress !== 'string');
const toml = `model="gpt-6.1-sol"\nmodel_provider="mcp_probe"\napproval_policy="on-request"\ndefault_permissions=":read-only"\n[features]\nbackground_paginated_rollout_migration=false\n[model_providers.mcp_probe]\nname="Local MCP probe"\nbase_url="http://127.0.0.1:${modelAddress.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[mcp_servers.covro]\ncommand="/unused-user-covro-server"\nenabled=false\n[mcp_servers."local.tools"]\ncommand="/unused-dotted-server"\nenabled=false\n`;
await writeFile(join(home, 'config.toml'), toml);
const portProbe = createPortProbe();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const webAddress = portProbe.address();
assert(webAddress && typeof webAddress !== 'string');
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
const origin = `http://127.0.0.1:${webAddress.port}`;
const config = parseConfig(
  {
    port: webAddress.port,
    publicOrigin: [origin],
    dataDir: join(root, 'data'),
    codex: { binary, home },
    projects: [
      { id: 'source', name: 'Source project', path: source },
      { id: 'target', name: 'Target project', path: target },
    ],
  },
  join(root, 'config.json'),
);
let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
let external: CodexAdapter | undefined;
const completed = new Set<string>();
async function waitFor(test: () => boolean, description: string) {
  const until = Date.now() + 30_000;
  while (!test()) {
    if (modelFailure) throw modelFailure;
    assert(Date.now() < until, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function gatewayTurn(threadId: string, text: string) {
  const op = await runtime!.service.startTurn(threadId, { clientOperationId: randomUUID(), text });
  const id = (op.result as { turnId: string }).turnId;
  await waitFor(
    () =>
      runtime!.service.projection
        .get(threadId)
        ?.turns.some((turn) => turn.id === id && turn.status === 'completed') === true,
    `gateway turn ${text}`,
  );
}
try {
  runtime = await startGateway(config, { staticDir: resolve('dist/web') });
  assert.equal(runtime.codex.diagnostics().codexVersion, CODEX_COMPATIBILITY.recommended);
  assert.equal(runtime.codex.ready, true);
  const pid = runtime.codex.pid;
  const managedRuntime = runtime;
  runtime.codex.onEvent((event) => {
    if (event.type !== 'action') return;
    if (
      event.action.kind !== 'elicitation' ||
      event.action.elicitation?.serverName !== managedRuntime.mcp.name
    ) {
      modelFailure = new Error('Unexpected approval requested by native probe');
      return;
    }
    approvals++;
    void managedRuntime.service
      .resolveAction(event.action.actionId, {
        clientOperationId: randomUUID(),
        resolution: { decision: allowCreation ? 'accept' : 'decline' },
      })
      .catch((error: Error) => {
        modelFailure = error;
      });
  });
  const parent = await runtime.service.createThread('source', { clientOperationId: randomUUID() });
  const parentId = (parent.result as { threadId: string }).threadId;
  await gatewayTurn(parentId, 'covro-mcp-probe-denied');
  await waitFor(
    () => runtime!.service.projection.get(parentId)?.title === 'MCP verification',
    'automatic title with injected MCP configuration',
  );
  assert.equal((await runtime.codex.readThreadMetadata(parentId)).title, 'MCP verification');
  checks.push('Automatic title is generated without tools and persisted with injected MCP enabled');
  assert(runtime.codex.recapThread);
  assert.equal(
    await runtime.codex.recapThread(parentId, 'covro-mcp-probe-recap'),
    'Local MCP recap verification complete.',
  );
  checks.push('Explicit recap completes without tools with the same injected MCP configuration');
  assert.equal((await runtime.service.listThreads('target')).data.length, 0);
  assert.equal(approvals, 1);
  checks.push('Declining the native MCP write approval creates no session');
  allowCreation = true;
  await gatewayTurn(parentId, 'covro-mcp-probe-parent');
  const targetThreads = (await runtime.service.listThreads('target')).data;
  assert.equal(
    targetThreads.length,
    1,
    JSON.stringify({ targetThreads, parent: runtime.service.projection.get(parentId), outputs }),
  );
  const childId = targetThreads[0]!.id;
  await waitFor(
    () => runtime!.service.projection.get(childId)?.status === 'completed',
    'child completion',
  );
  const child = await runtime.service.getThread(childId);
  assert.equal(child.cwd, target);
  assert.equal(child.managed, true);
  assert.equal(child.historyVisible, true);
  assert(
    child.turns.some((turn) => turn.items.some((item) => item.text === 'covro-mcp-probe-child')),
  );
  assert.equal(runtime.codex.pid, pid);
  checks.push('Native Code Mode discovers and calls list_projects and create_session through MCP');
  checks.push(
    'Parent waiting on MCP can create and submit a child in the selected project on the same app-server',
  );
  await gatewayTurn(childId, 'covro-mcp-probe-followup');
  checks.push('Covro continues the MCP-created conversation without writer conflict');
  await runtime.codex.stop();
  await runtime.codex.start();
  await runtime.service.resumeThread(childId, { clientOperationId: randomUUID() });
  await gatewayTurn(childId, 'covro-mcp-probe-restart');
  assert(fired.has('restart'));
  assert(outputs.some((output) => output.includes('project_id') && output.includes('target')));
  checks.push('Managed app-server restart reapplies the local MCP entry to resumed history');
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), toml);
  checks.push(
    'User configuration, including an existing covro MCP entry, remains byte-for-byte unchanged',
  );
  const endpoint = runtime.mcp.url;
  await runtime.close();
  runtime = undefined;
  await assert.rejects(fetch(endpoint));
  checks.push('Gateway shutdown closes the local MCP endpoint');
  external = new CodexAdapter({ binary, home });
  external.onEvent((event) => {
    if (event.type === 'turn' && event.turn.status === 'completed') completed.add(event.turn.id);
  });
  await external.start();
  await external.resumeThread(childId, target);
  const turn = await external.startTurn(childId, target, 'covro-mcp-probe-external');
  await waitFor(() => completed.has(turn.id), 'external resumed turn');
  assert(outputs.some((output) => output.includes('external-no-covro')));
  checks.push(
    'Independent app-server with the same CODEX_HOME and resumed history has no injected Covro tools',
  );
  await external.stop();
  external = undefined;
  const report = {
    codexVersion: CODEX_COMPATIBILITY.recommended,
    inference: false,
    model: 'local HTTP stub',
    checks,
  };
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0)
    await writeFile(resolve(args[outputIndex + 1]!), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (args.includes('--keep')) {
    runtime = await startGateway(config, { staticDir: resolve('dist/web') });
    const client = new Client({ name: 'covro-browser-evidence', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcp.url)));
    await client.callTool({ name: 'list_projects', arguments: {} });
    const demo = await client.callTool({
      name: 'create_session',
      arguments: {
        project_id: 'target',
        prompt: 'Confirm this project is ready for a new task.',
        request_key: randomUUID(),
      },
    });
    await client.close();
    const demoContent = demo.structuredContent as { thread_id?: unknown } | undefined;
    assert.equal(typeof demoContent?.thread_id, 'string');
    const demoId = String(demoContent!.thread_id);
    await waitFor(
      () => runtime!.service.projection.get(demoId)?.status === 'completed',
      'browser demo completion',
    );
    console.log(
      JSON.stringify({
        browserOrigin: origin,
        projectId: 'target',
        threadId: demoId,
        root,
        pid: process.pid,
      }),
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
} finally {
  await external?.stop();
  await runtime?.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

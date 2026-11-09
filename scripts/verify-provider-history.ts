/** Real provider switch and archive/history probe; fresh homes and local model stub only. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';
import { RpcTransport } from '../src/codex/transport.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
assert(configIndex >= 0, 'Pass --config selecting an existing 0.167.0 binary');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
const root = await mkdtemp(join(tmpdir(), 'covro-provider-history-'));
let responseId = 0;
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  const id = `provider-${++responseId}`;
  const item = {
    type: 'message',
    id,
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Saved provider history' }],
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
            `[model_providers.${id}]\nname = "Isolated ${id} provider"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
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
    assert.equal(adapter.diagnostics().codexVersion, '0.167.0');
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
    await assert.rejects(adapter.resumeThread(saved[0]!.id, project), (error: unknown) => {
      assert.equal(
        (error as { details?: { modelProviderError?: { type?: string } } }).details
          ?.modelProviderError?.type,
        'modelProviderMismatch',
      );
      return true;
    });
    checks.push(
      `${historyMode}: provider switch retains active/archived discovery, exact cwd, archive state and readable text; mismatched resume rejected`,
    );
    await adapter.stop();
  }
  console.log(
    JSON.stringify({ version: '0.167.0', inference: false, localStub: true, checks }, null, 2),
  );
} finally {
  await Promise.all(adapters.map((adapter) => adapter.stop()));
  await Promise.all(children.map(stop));
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

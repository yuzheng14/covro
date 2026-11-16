/** Exact selected target binary, fresh homes and a local Responses stub; no account or inference. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RpcTransport } from '../src/codex/transport.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';

const args = process.argv.slice(2);
const versionIndex = args.indexOf('--expected-version');
const expectedVersion = versionIndex >= 0 ? args[versionIndex + 1]! : '0.169.0';
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const configIndex = args.indexOf('--config');
assert(configIndex >= 0, 'Pass --config with an existing complete target installation');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
assert.equal(
  (await promisify(execFile)(codex.binary, ['--version'])).stdout.trim(),
  `codex-cli ${expectedVersion}`,
);
const root = await mkdtemp(join(tmpdir(), 'covro169-boundaries-'));
let nextResponse: ((response: ServerResponse, body: { input: unknown[] }) => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!nextResponse) {
    process.stderr.write(`Unexpected local request: ${request.method} ${request.url}\n`);
    response.writeHead(500);
    response.end();
    return;
  }
  const respond = nextResponse;
  nextResponse = undefined;
  respond(response, JSON.parse(Buffer.concat(chunks).toString()));
});
function finish(response: ServerResponse, item: object) {
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
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
function call(id: string, input: string) {
  return { type: 'custom_tool_call', name: 'exec', namespace: 'functions', id, call_id: id, input };
}
function message(text: string) {
  return {
    type: 'message',
    id: 'answer',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text }],
  };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!test()) {
    assert(Date.now() < deadline, 'Timed out waiting for native boundary probe');
    await new Promise((done) => setTimeout(done, 20));
  }
}
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const checks: string[] = [];
try {
  for (const historyMode of ['legacy', 'paginated']) {
    const home = join(root, `${historyMode}-home`);
    const project = join(root, `${historyMode}-project`);
    await mkdir(home);
    await mkdir(project);
    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-6.1-sol"\nmodel_provider = "stub"\napproval_policy = "on-request"\ndefault_permissions = ":read-only"\n[model_providers.stub]\nname = "Isolated boundary probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nbackground_paginated_rollout_migration = false\n`,
    );
    const child = spawn(codex.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: project,
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const rpc = new RpcTransport(child.stdin, child.stdout);
    const turns = new Map<string, string>();
    const approvals: { id: string | number; method: string }[] = [];
    rpc.on(
      'notification',
      (event: { method: string; params: { turn?: { id: string; status: string } } }) => {
        if (event.method === 'turn/completed' && event.params.turn)
          turns.set(event.params.turn.id, event.params.turn.status);
      },
    );
    rpc.on('request', (event: { id: string | number; method: string }) => approvals.push(event));
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'codex_web_ui', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      await rpc.notify('initialized');
      const { thread } = await rpc.request<ThreadStartResponse>('thread/start', {
        cwd: project,
        historyMode,
      });
      const start = (text: string) =>
        rpc.request<TurnStartResponse>('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text, text_elements: [] }],
        });
      let output = '';
      nextResponse = (response) => {
        nextResponse = (continued, body) => {
          output = JSON.stringify(
            body.input.filter(
              (item) =>
                typeof item === 'object' &&
                item !== null &&
                'type' in item &&
                String(item.type).endsWith('call_output'),
            ),
          );
          finish(continued, message('Large Code Mode output completed'));
        };
        finish(
          response,
          call(
            'large-output',
            `text('CODEX169_OUTPUT:'+Array.from({length:40000},(_,i)=>'output_'+i).join(' '));`,
          ),
        );
      };
      const large = await start('Exercise the default Code Mode output budget');
      await until(() => turns.has(large.turn.id));
      assert.equal(turns.get(large.turn.id), 'completed');
      assert(output.includes('CODEX169_OUTPUT:'), 'Expected real Code Mode output');
      assert(output.length < 100000, `Output was not bounded: ${output.length}`);
      assert.match(output, /truncat|omitted|tokens/i);
      checks.push(
        `${historyMode}: default Code Mode executes over the bundled host and bounds a 500 KB text result (${output.length} bytes delivered)`,
      );

      const outside = join(root, `${historyMode}-must-not-exist.txt`);
      const patch = `*** Begin Patch\n*** Add File: ${outside}\n+isolated approval marker\n*** End Patch`;
      nextResponse = (response) =>
        finish(
          response,
          call('late-patch', `text(await tools.apply_patch(${JSON.stringify(patch)}));`),
        );
      const old = await start('Request an isolated file approval and wait');
      await until(() => approvals.length > 0 || turns.has(old.turn.id));
      assert(approvals[0], 'Expected a file approval');
      assert.equal(approvals[0].method, 'item/fileChange/requestApproval');
      await rpc.request('turn/interrupt', { threadId: thread.id, turnId: old.turn.id });
      await until(() => turns.has(old.turn.id));
      assert.equal(turns.get(old.turn.id), 'interrupted');
      let held: ServerResponse | undefined;
      nextResponse = (response) => {
        held = response;
      };
      const newer = await start('Keep the newer turn running across a stale reply');
      await until(() => Boolean(held));
      await rpc.respond(approvals[0].id, { decision: 'cancel' });
      await new Promise((done) => setTimeout(done, 250));
      assert(!turns.has(newer.turn.id), 'A stale approval reply interrupted the new turn');
      finish(held!, message('Newer turn survived stale file approval'));
      await until(() => turns.has(newer.turn.id));
      assert.equal(turns.get(newer.turn.id), 'completed');
      await assert.rejects(readFile(outside), { code: 'ENOENT' });
      checks.push(
        `${historyMode}: interrupting a pending file approval then delivering its late cancel leaves the newer turn completed and never writes the file`,
      );
    } catch (error) {
      process.stderr.write(stderr);
      throw error;
    } finally {
      const stopped = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped;
      clearTimeout(timer);
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
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

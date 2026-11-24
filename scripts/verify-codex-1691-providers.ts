/** Exact target binary, temporary homes, fictional credentials and loopback Responses only. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RpcTransport } from '../src/codex/transport.js';
import { readModels } from '../src/codex/models.js';
import type { ModelListResponse } from '../src/codex/generated/v2/ModelListResponse.js';
import type { ThreadStartResponse } from '../src/codex/generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../src/codex/generated/v2/TurnStartResponse.js';

const args = process.argv.slice(2);
const versionIndex = args.indexOf('--expected-version');
const expectedVersion = versionIndex >= 0 ? args[versionIndex + 1]! : '0.169.1';
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const configIndex = args.indexOf('--config');
assert(configIndex >= 0, 'Pass --config selecting the existing complete target installation');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
assert.equal(
  (await promisify(execFile)(codex.binary, ['--version'])).stdout.trim(),
  `codex-cli ${expectedVersion}`,
);
const root = await mkdtemp(join(tmpdir(), 'covro1691-providers-'));
type InputItem = {
  type: string;
  id?: string;
  role?: string;
  content?: { type: string; text: string; annotations?: unknown[] }[];
  tools?: unknown[];
  [key: string]: unknown;
};
type RequestBody = { model: string; input: InputItem[]; tools?: unknown[] };
let nextResponse: ((response: ServerResponse, body: RequestBody) => void) | undefined;
let failure: unknown;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert(nextResponse, `Unexpected local request ${request.method} ${request.url}`);
    const reply = nextResponse;
    nextResponse = undefined;
    reply(response, JSON.parse(Buffer.concat(chunks).toString()));
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end();
  }
});
function finish(response: ServerResponse, output: object[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    { type: 'response.created', response: { id: 'local-provider-response' } },
    ...output.map((item, output_index) => ({
      type: 'response.output_item.done',
      output_index,
      item,
    })),
    {
      type: 'response.completed',
      response: {
        id: 'local-provider-response',
        status: 'completed',
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
function answer() {
  return {
    type: 'message',
    id: 'final-answer',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Local provider replay checked', annotations: [] }],
  };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!test()) {
    if (failure) throw failure;
    assert(Date.now() < deadline, 'Native provider probe timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const checks: string[] = [];
const catalogs: { provider: string; models: string[] }[] = [];
try {
  for (const provider of [
    'amazon-bedrock',
    'amazon-bedrock-runtime',
    ...(['0.170.0', '0.171.0', '0.172.0'].includes(expectedVersion) ? ['gcp'] : []),
  ]) {
    for (const optOut of [false, true]) {
      const home = join(root, `${provider}-${optOut}`);
      const project = join(home, 'project');
      await mkdir(project, { recursive: true });
      await writeFile(
        join(home, 'config.toml'),
        `model_provider = "${provider}"\napproval_policy = "never"\ndefault_permissions = ":read-only"\n[model_providers.${provider}]\nbase_url = "http://127.0.0.1:${address.port}/v1"\n` +
          (provider === 'gcp'
            ? `[model_providers.gcp.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", "process.stdout.write('LOCAL_STUB_ONLY')"]\ncwd = ${JSON.stringify(home)}\ntimeout_ms = 5000\nrefresh_interval_ms = 60000\n`
            : `[model_providers.${provider}.aws]\nregion = "us-east-1"\n`) +
          `[agents]\nenabled = false\n[features]\nbackground_paginated_rollout_migration = false\n${optOut ? `${provider === 'gcp' ? 'incremental_tools_legacy_gcp' : 'incremental_tools_legacy'} = false\n` : ''}`,
      );
      const child = spawn(codex.binary, ['app-server', '--listen', 'stdio://'], {
        cwd: project,
        env: {
          ...process.env,
          CODEX_HOME: home,
          OPENAI_API_KEY: '',
          CODEX_API_KEY: '',
          AWS_PROFILE: '',
          AWS_ACCESS_KEY_ID: '',
          AWS_SECRET_ACCESS_KEY: '',
          AWS_SESSION_TOKEN: '',
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_SHARED_CREDENTIALS_FILE: join(home, 'no-aws-credentials'),
          AWS_CONFIG_FILE: join(home, 'no-aws-config'),
          GOOGLE_APPLICATION_CREDENTIALS: join(home, 'no-google-credentials'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      const rpc = new RpcTransport(child.stdin, child.stdout);
      const completed = new Set<string>();
      rpc.on(
        'notification',
        (event: { method: string; params: { turn?: { id: string; status: string } } }) => {
          if (event.method === 'turn/completed' && event.params.turn?.status === 'completed')
            completed.add(event.params.turn.id);
        },
      );
      rpc.on('request', (request: { id: string | number }) => {
        void rpc.reject(request.id, -32601, 'No approvals in local provider probe');
      });
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'codex_web_ui', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        await rpc.notify('initialized');
        if (!optOut) {
          for (const id of [provider, ...(provider === 'amazon-bedrock' ? ['gcp'] : [])]) {
            const models = await readModels(
              (params) => rpc.request<ModelListResponse>('model/list', params),
              id,
            );
            const prefix =
              id === 'amazon-bedrock'
                ? 'openai.'
                : id === 'amazon-bedrock-runtime'
                  ? 'global.openai.'
                  : '';
            assert.equal(models[0]?.id, `${prefix}gpt-6.2-sol`);
            const astra = models.find((model) => model.id === `${prefix}gpt-6.2-astra`);
            assert(astra);
            if (id !== 'gcp') {
              assert(astra.serviceTiers?.includes('ultrafast'));
              assert(
                !astra.serviceTiers?.includes('fast'),
                'Ultrafast must not be relabeled as Fast',
              );
            }
            if (id === 'amazon-bedrock-runtime')
              assert(models.some((model) => model.id === 'us.openai.gpt-6.2-astra'));
            catalogs.push({ provider: id, models: models.map((model) => model.id) });
            checks.push(
              `${id}: native scoped catalog includes GPT-6.2 Sol/Astra and new default ordering${id === 'gcp' ? '' : '; ultrafast stays independent of Fast'}`,
            );
          }
        }
        // Fictional local credentials only. Both native provider endpoints are pinned to loopback.
        if (provider !== 'gcp')
          await rpc.request(
            'account/login/start',
            provider === 'amazon-bedrock'
              ? { type: 'amazonBedrock', apiKey: 'LOCAL_STUB_ONLY', region: 'us-east-1' }
              : {
                  type: 'amazonBedrockAccessKeys',
                  accessKeyId: 'LOCAL_STUB_ACCESS_KEY',
                  secretAccessKey: 'LOCAL_STUB_ONLY',
                  region: 'us-east-1',
                },
          );
        const prefix =
          provider === 'gcp' ? '' : provider === 'amazon-bedrock' ? 'openai.' : 'global.openai.';
        const { thread } = await rpc.request<ThreadStartResponse>('thread/start', {
          cwd: project,
          modelProvider: provider,
          allowProviderModelFallback: true,
        });
        assert.equal(thread.model, `${prefix}gpt-6.2-sol`);
        const start = (text: string) =>
          rpc.request<TurnStartResponse>('turn/start', {
            threadId: thread.id,
            input: [{ type: 'text', text, text_elements: [] }],
          });
        const bodies: RequestBody[] = [];
        const record = (body: RequestBody) => {
          bodies.push(body);
          const declarations = body.input.filter((item) => item.type === 'additional_tools');
          if (bodies.length === 1) {
            assert.equal(declarations.length > 0, !optOut);
            if (optOut) assert((body.tools?.length ?? 0) > 0);
          }
        };
        const checkReplay = (body: RequestBody) => {
          record(body);
          const progress = body.input.find(
            (item) =>
              item.role === 'assistant' && item.content?.some((part) => part.text === 'Checking.'),
          );
          assert(progress?.content);
          assert.equal(
            Object.hasOwn(progress.content[0]!, 'annotations'),
            provider !== 'amazon-bedrock',
          );
          assert.deepEqual(progress.content[1]?.annotations, [
            {
              type: 'url_citation',
              url: 'https://example.org',
              title: 'Local citation',
              start_index: 0,
              end_index: 6,
            },
          ]);
          const index = body.input.indexOf(progress);
          assert.equal(body.input[index + 1]?.type, 'reasoning');
          assert.equal(body.input[index + 2]?.type, 'function_call');
          assert.equal(body.input[index + 3]?.type, 'function_call_output');
        };
        nextResponse = (response, body) => {
          record(body);
          if (optOut || provider === 'gcp') {
            finish(response, [answer()]);
            return;
          }
          nextResponse = (continued, continuedBody) => {
            checkReplay(continuedBody);
            finish(continued, [answer()]);
          };
          finish(response, [
            {
              type: 'message',
              id: 'progress',
              role: 'assistant',
              phase: 'commentary',
              content: [
                { type: 'output_text', text: 'Checking.', annotations: [] },
                {
                  type: 'output_text',
                  text: 'Source',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://example.org',
                      title: 'Local citation',
                      start_index: 0,
                      end_index: 6,
                    },
                  ],
                },
              ],
            },
            {
              type: 'reasoning',
              id: 'reasoning',
              summary: [],
              encrypted_content: 'local-reasoning',
            },
            {
              type: 'function_call',
              id: 'local-code',
              call_id: 'local-code',
              name: 'update_plan',
              arguments: JSON.stringify({
                plan: [{ step: 'Check local replay', status: 'completed' }],
              }),
            },
          ]);
        };
        const first = await start('Exercise local provider tools and commentary replay');
        await until(() => completed.has(first.turn.id));
        if (!optOut && provider !== 'gcp') {
          nextResponse = (response, body) => {
            checkReplay(body);
            const final = body.input.find(
              (item) =>
                item.role === 'assistant' &&
                item.content?.some((part) => part.text === 'Local provider replay checked'),
            );
            assert.deepEqual(final?.content?.[0]?.annotations, []);
            finish(response, [answer()]);
          };
          const second = await start('Continue the local replay check');
          await until(() => completed.has(second.turn.id));
          assert.equal(bodies.length, 3);
          checks.push(
            `${provider}: incremental tool declarations enabled by default; commentary/reasoning/tool ordering and final-answer annotations survive continuation and next turn`,
          );
        } else if (provider === 'gcp')
          checks.push(
            `gcp: ${optOut ? 'explicit incremental_tools_legacy_gcp=false retains top-level tools' : 'incremental tool declarations enabled by default'} using a fictional command token and loopback only`,
          );
        else
          checks.push(
            `${provider}: explicit incremental_tools_legacy=false retains top-level tool declarations`,
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
  }
  console.log(
    JSON.stringify(
      {
        version: expectedVersion,
        inference: false,
        localStub: true,
        fictionalCredentialsOnly: true,
        checks,
        catalogs,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

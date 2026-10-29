/** Exact-binary local Responses stub; no credentials, real inference or existing history. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexAdapter, type AdapterEvent } from '../src/codex/adapter.js';

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
assert(configIndex >= 0, 'Pass --config with an explicitly selected 0.164.0 binary');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string };
};
assert.equal(
  (await promisify(execFile)(codex.binary, ['--version'])).stdout.trim(),
  'codex-cli 0.164.0',
);
const root = await mkdtemp(join(tmpdir(), 'covro-live-settings-'));
const requests: {
  model: string;
  service_tier?: string;
  reasoning?: { effort: string };
  tools?: { name?: string; type?: string; tools?: { name: string }[] }[];
}[] = [];
let firstResponse: ServerResponse | undefined;
let modelCall = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
  // Title generation uses an independent ephemeral session and must not consume the barrier.
  if (JSON.stringify(body).includes('Generate a concise')) {
    finish(response, message(JSON.stringify({ title: 'Local settings check' })));
    return;
  }
  requests.push(body);
  if (modelCall++ === 0) {
    firstResponse = response;
    return;
  }
  finish(response, message('Local settings check complete'));
});
function message(text: string) {
  return {
    type: 'message',
    id: `message-${modelCall}`,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    phase: 'final_answer',
  };
}
function finish(response: ServerResponse, item: object) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: `response-${modelCall}` } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: `response-${modelCall}`,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!test()) {
    assert(Date.now() < deadline, 'Timed out waiting for local binary');
    await new Promise((done) => setTimeout(done, 20));
  }
}
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const home = join(root, 'home');
const project = join(root, 'project');
await mkdir(home);
await mkdir(project);
await writeFile(
  join(home, 'config.toml'),
  `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\nservice_tier = "default"\nmodel_provider = "live_stub"\napproval_policy = "never"\ndefault_permissions = ":read-only"\n[model_providers.live_stub]\nname = "Isolated live settings check"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nstep_model_switching = true\nguardian_approval = true\nbackground_paginated_rollout_migration = false\n`,
);
const adapter = new CodexAdapter({ binary: codex.binary, home });
const events: AdapterEvent[] = [];
adapter.onEvent((event) => events.push(event));
const checks: string[] = [];
try {
  await adapter.start();
  const thread = await adapter.createThread(project, { permissionMode: 'ask' });
  assert.equal(thread.runtimeSettings?.liveSettingsCapabilities?.fast, true);
  const turn = await adapter.startTurn(
    thread.id,
    project,
    'Use a shell command to print a harmless local marker, then finish.',
  );
  await until(() => Boolean(firstResponse));
  const published = await adapter.updateLiveSettings(thread.id, project, turn.id, {
    serviceTier: 'fast',
  });
  assert.deepEqual(published, { serviceTier: 'fast' });
  checks.push('Fast acknowledged while first model request is still in flight');
  finish(firstResponse!, {
    type: 'custom_tool_call',
    id: 'call-local',
    call_id: 'call-local',
    name: 'exec',
    namespace: 'functions',
    input:
      'text(await tools.exec_command({cmd:"printf live-settings-check",sandbox_permissions:"require_escalated",justification:"Isolated pending approval test; the request will be denied",max_output_tokens:100}));',
  });
  await until(() => events.some((event) => event.type === 'action')).catch((error) => {
    console.log(
      JSON.stringify(
        events.filter((event) => event.type === 'item' || event.type === 'turnError'),
        null,
        2,
      ),
    );
    throw error;
  });
  const action = events.find((event) => event.type === 'action');
  assert(action?.type === 'action');
  assert.deepEqual(
    await adapter.updateLiveSettings(thread.id, project, turn.id, {
      permissionMode: 'auto-review',
    }),
    { approvalReviewer: 'auto_review' },
  );
  assert(
    !events.some(
      (event) => event.type === 'actionResolved' && event.actionId === action.action.actionId,
    ),
  );
  await adapter.respond(action.action.actionId, { decision: 'decline' });
  checks.push(
    'Reviewer publication preserves the existing human approval, which is explicitly denied',
  );
  await until(() => requests.length >= 2);
  assert.equal(requests[0]!.model, 'gpt-6.1-sol');
  assert.equal(requests[1]!.model, requests[0]!.model);
  assert.equal(requests[1]!.reasoning?.effort, requests[0]!.reasoning?.effort);
  assert.equal(requests[1]!.service_tier, 'priority');
  checks.push('Later model request in the same turn uses priority; model/effort stay unchanged');
  await until(() =>
    events.some(
      (event) =>
        event.type === 'turn' && event.turn.id === turn.id && event.turn.status === 'completed',
    ),
  );
  await assert.rejects(
    adapter.updateLiveSettings(thread.id, project, turn.id, { serviceTier: null }),
    (error: unknown) => (error as { code?: string }).code === 'TURN_CONFLICT',
  );
  const nextModel = adapter
    .diagnostics()
    .models.find(
      (entry) => entry.id !== 'gpt-6.1-sol' && entry.reasoningEfforts.includes('high'),
    )?.id;
  assert(nextModel, 'Need a second catalog model for the next-turn assertion');
  const next = await adapter.startTurn(thread.id, project, 'Next turn', {
    model: nextModel,
    reasoningEffort: 'high',
    serviceTier: null,
  });
  await until(() =>
    events.some(
      (event) =>
        event.type === 'turn' && event.turn.id === next.id && event.turn.status === 'completed',
    ),
  );
  assert.equal(requests.at(-1)!.model, nextModel);
  assert.equal(requests.at(-1)!.reasoning?.effort, 'high');
  assert.notEqual(requests.at(-1)!.service_tier, 'priority');
  checks.push(
    'New model/effort and explicit standard speed appear in the next actual model request',
  );
  console.log(
    JSON.stringify(
      {
        version: '0.164.0',
        inference: false,
        localStub: true,
        checks,
        requests: requests.map(({ model, service_tier, reasoning }) => ({
          model,
          service_tier,
          reasoning,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  firstResponse?.destroy();
  await adapter.stop();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}

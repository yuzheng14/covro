import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const resources: { adapter: CodexAdapter; directory: string }[] = [];
afterEach(async () => {
  for (const { adapter, directory } of resources.splice(0)) {
    await adapter.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(options: SimulatorOptions = {}, titleTimeoutMs = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-auto-title-'));
  const logPath = join(directory, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ turnDelayMs: 10, ...options, logPath }),
    ],
    titleTimeoutMs,
  });
  resources.push({ adapter, directory });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  const requests = async () =>
    (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
            error?: unknown;
          },
      );
  return { adapter, events, requests };
}

it('generates once outside the user history, persists the title, and hides temporary events', async () => {
  const { adapter, events, requests } = await fixture({ titleDelayMs: 150, ackDelayMs: 30 });
  const thread = await adapter.createThread('/tmp');
  const prompt = '解释一下运行设置如何继承 Codex 配置';
  const first = await adapter.startTurn(thread.id, thread.cwd, prompt);
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe(prompt);
  await vi.waitFor(async () => {
    expect((await adapter.readThreadMetadata(thread.id)).title).toBe('Codex 配置继承与运行设置');
  });
  expect(events).toContainEqual({
    type: 'threadName',
    threadId: thread.id,
    name: 'Codex 配置继承与运行设置',
  });
  const history = await adapter.readThread(thread.id);
  expect(history.turns.map((turn) => turn.id)).toEqual([first.id]);
  expect(history.turns[0]?.items.find((item) => item.type === 'userMessage')?.text).toBe(prompt);
  await adapter.startTurn(thread.id, thread.cwd, '后续消息');
  await vi.waitFor(async () => {
    expect(
      (await requests()).filter((entry) => entry.method === 'thread/unsubscribe'),
    ).toHaveLength(1);
  });
  const sent = await requests();
  expect(sent.filter((entry) => entry.method === 'thread/name/set')).toHaveLength(1);
  const temporary = sent.find(
    (entry) => entry.method === 'thread/start' && entry.params?.ephemeral,
  );
  expect(temporary?.params).toMatchObject({
    ephemeral: true,
    model: 'simulated-model',
    modelProvider: 'openai',
    sandbox: 'read-only',
    threadSource: 'thread_title',
    runtimeWorkspaceRoots: [],
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    config: {
      'features.shell_tool': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.multi_agent': false,
      'features.unified_exec': false,
      'features.view_image': false,
      'skills.include_instructions': false,
      default_permissions: ':read-only',
      web_search: 'disabled',
      mcp_servers: { 'fixture.tools': { enabled: false } },
    },
  });
  expect(temporary?.params).toHaveProperty('config.mcp_servers', {
    'fixture.tools': { enabled: false },
  });
  expect(
    sent.find((entry) => entry.method === 'turn/start' && entry.params?.threadId !== thread.id)
      ?.params,
  ).toMatchObject({
    outputSchema: { required: ['title'], properties: { title: { maxLength: 36 } } },
  });
  expect(temporary?.params).not.toHaveProperty('approvalPolicy');
  expect(
    sent.find((entry) => entry.method === 'turn/start' && entry.params?.threadId !== thread.id)
      ?.params,
  ).not.toHaveProperty('effort');
  expect(events.filter((event) => event.type === 'thread').map((event) => event.thread.id)).toEqual(
    [thread.id],
  );
  expect(
    events.filter((event) => 'threadId' in event).every((event) => event.threadId === thread.id),
  ).toBe(true);
  expect((await adapter.listThreads(thread.cwd)).data.map((entry) => entry.id)).toEqual([
    thread.id,
  ]);
});

it.each([
  'not json',
  '{}',
  '{"title":"   "}',
  '{"title":"Valid","extra":true}',
  JSON.stringify({ title: '长'.repeat(3000) }),
])('keeps the preview when the title output is invalid: %s', async (titleOutput) => {
  const { adapter, requests } = await fixture({ titleOutput });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
  );
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('第一条问题');
  expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
  expect(adapter.ready).toBe(true);
});

it('accepts a late thread/started notification without losing the naming job', async () => {
  const { adapter, requests } = await fixture({ threadStartedDelayMs: 30, titleDelayMs: 100 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
  );
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('Codex 配置继承与运行设置');
});

it.each(['fail', 'hang', 'rename', 'interaction'] as const)(
  'cleans up a %s naming attempt without changing task execution',
  async (titleBehavior) => {
    const { adapter, events, requests } = await fixture({ titleBehavior }, 150);
    const thread = await adapter.createThread('/tmp');
    const turn = await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
    await vi.waitFor(async () =>
      expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
    );
    // Naming cleanup and the user's turn finish independently under CI load.
    await vi.waitFor(async () =>
      expect((await adapter.readThread(thread.id)).turns[0]).toMatchObject({
        id: turn.id,
        status: 'completed',
      }),
    );
    const history = await adapter.readThread(thread.id);
    expect(history.title).toBe(titleBehavior === 'rename' ? '用户手动命名' : '第一条问题');
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]).toMatchObject({ id: turn.id, status: 'completed' });
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
    expect(events.some((event) => event.type === 'action')).toBe(false);
    if (titleBehavior === 'hang') {
      const interrupt = (await requests()).find((r) => r.method === 'turn/interrupt');
      expect(interrupt?.params?.threadId).toBeDefined();
      expect(interrupt?.params?.threadId).not.toBe(thread.id);
    }
    expect(adapter.ready).toBe(true);
  },
);

it('does not rename explicitly named sessions, including a name equal to the placeholder', async () => {
  const { adapter, requests } = await fixture({ threadNames: ['新会话'] });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('新会话');
  expect((await requests()).some((r) => r.params?.ephemeral)).toBe(false);
});

it('keeps an inherited fork name, and isolates two concurrent naming jobs', async () => {
  const { adapter, requests } = await fixture();
  const first = await adapter.createThread('/tmp');
  const second = await adapter.createThread('/tmp');
  await Promise.all(
    [first, second].map((thread) => adapter.startTurn(thread.id, thread.cwd, thread.id)),
  );
  await vi.waitFor(async () =>
    expect((await requests()).filter((r) => r.method === 'thread/name/set')).toHaveLength(2),
  );
  const fork = await adapter.forkThread(first.id, first.cwd);
  await adapter.startTurn(fork.id, fork.cwd, 'fork 后的问题');
  expect((await requests()).filter((r) => r.params?.ephemeral)).toHaveLength(2);
  expect((await adapter.readThread(fork.id)).turns).toHaveLength(2);
});

it.each([
  ['chatgpt', 'openai', ['simulated-model', 'gpt-5.6-luna'], 'gpt-5.6-luna'],
  ['chatgpt', 'openai', ['simulated-model'], 'simulated-model'],
  ['apiKey', 'openai', ['simulated-model', 'gpt-5.6-luna'], 'simulated-model'],
  ['chatgpt', 'custom', ['simulated-model', 'gpt-5.6-luna'], 'simulated-model'],
] as const)(
  'selects the CLI title model for %s / %s / %j',
  async (accountType, modelProvider, models, expected) => {
    const { adapter, requests } = await fixture({
      accountType,
      modelProvider,
      models: [...models],
    });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, 'Explain the model');
    await vi.waitFor(async () =>
      expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
    );
    const sent = await requests();
    expect(sent.find((r) => r.params?.ephemeral)?.params).toMatchObject({
      model: expected,
      modelProvider,
    });
    const namingTurn = sent.find(
      (r) => r.method === 'turn/start' && r.params?.threadId !== thread.id,
    );
    expect(namingTurn?.params?.effort).toBe(expected === 'gpt-5.6-luna' ? 'low' : undefined);
  },
);

it('waits for an accepted user-message event instead of the turn receipt', async () => {
  const { adapter, requests } = await fixture({ userMessageDelayMs: 150 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  expect((await requests()).some((r) => r.params?.ephemeral)).toBe(false);
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
  );
});

it('retries only after another user message, using that message and the current model', async () => {
  const { adapter, requests } = await fixture({
    titleOutputs: ['not json'],
    models: ['simulated-model', 'another-model'],
  });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(1),
  );
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('第一条问题');
  await adapter.resumeThread(thread.id, thread.cwd);
  expect((await requests()).filter((r) => r.params?.ephemeral)).toHaveLength(1);
  await adapter.startTurn(thread.id, thread.cwd, '第二条问题', { model: 'another-model' });
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
  );
  const sent = await requests();
  expect(sent.filter((r) => r.params?.ephemeral)).toHaveLength(2);
  expect(sent.filter((r) => r.params?.ephemeral).at(-1)?.params?.model).toBe('another-model');
  expect(
    JSON.stringify(sent.filter((r) => r.method === 'turn/start').at(-1)?.params?.input),
  ).toContain('第二条问题');
});

it('names an unnamed fork only when it receives a new user message', async () => {
  const { adapter, requests } = await fixture({ titleOutputs: ['not json'] });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
  );
  const fork = await adapter.forkThread(thread.id, thread.cwd);
  expect((await requests()).filter((r) => r.params?.ephemeral)).toHaveLength(1);
  await adapter.startTurn(fork.id, fork.cwd, '处理分支任务');
  await vi.waitFor(async () =>
    expect((await adapter.readThreadMetadata(fork.id)).title).toBe('Codex 配置继承与运行设置'),
  );
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('第一条问题');
});

it('does not start duplicate title jobs when another message arrives during generation', async () => {
  const { adapter, requests } = await fixture({ titleDelayMs: 250 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await adapter.readThread(thread.id)).turns[0]?.status).toBe('completed'),
  );
  await adapter.startTurn(thread.id, thread.cwd, '第二条问题');
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
  );
  expect((await requests()).filter((r) => r.params?.ephemeral)).toHaveLength(1);
});

it.each([true, false])(
  'preserves custom permission profiles and checks the temporary response (matches: %s)',
  async (matches) => {
    const { adapter, requests } = await fixture({
      activePermissionProfile: 'managed',
      temporaryPermissionProfile: matches ? 'managed' : 'other',
    });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
    await vi.waitFor(async () =>
      expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
    );
    const sent = await requests();
    const temporary = sent.find((r) => r.params?.ephemeral);
    expect(temporary?.params?.permissions).toBe('managed');
    expect(temporary?.params).not.toHaveProperty('sandbox');
    expect(sent.some((r) => r.method === 'thread/name/set')).toBe(matches);
  },
);

it('cancels pending naming when the runtime stops and never sends it to the replacement process', async () => {
  const { adapter, requests } = await fixture({ titleBehavior: 'hang' });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).filter((r) => r.method === 'turn/start')).toHaveLength(2),
  );
  await adapter.stop();
  await adapter.start();
  expect(adapter.ready).toBe(true);
  expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
});

it('isolates an explicit recap and cleans up its temporary thread without renaming the source', async () => {
  const { adapter, events, requests } = await fixture();
  const thread = await adapter.createThread('/tmp');
  const summary = await adapter.recapThread(thread.id, 'Summarize visible conversation data.');
  expect(summary).toContain('下一步');
  expect((await adapter.readThread(thread.id)).turns).toHaveLength(0);
  expect(events.some((event) => event.type === 'threadName')).toBe(false);
  const calls = await requests();
  const start = calls.find(
    (call) => call.method === 'thread/start' && call.params?.threadSource === 'recap',
  );
  expect(start?.params).toMatchObject({
    ephemeral: true,
    sandbox: 'read-only',
    runtimeWorkspaceRoots: [],
    dynamicTools: [],
    config: {
      'features.shell_tool': false,
      'features.goals': false,
      'features.apps': false,
      'features.plugins': false,
    },
  });
  const internalTurn = calls.find((call) => call.method === 'turn/start');
  expect(internalTurn?.params?.threadId).not.toBe(thread.id);
  expect(calls.some((call) => call.method === 'thread/unsubscribe')).toBe(true);
  expect(events.filter((event) => 'threadId' in event && event.threadId !== thread.id)).toEqual([]);
});
it('times out a recap without interrupting or writing to the source thread', async () => {
  const { adapter, requests } = await fixture({ titleBehavior: 'hang' }, 40);
  const thread = await adapter.createThread('/tmp');
  await expect(adapter.recapThread(thread.id, 'Summarize')).rejects.toMatchObject({
    code: 'RECAP_FAILED',
  });
  const calls = await requests();
  expect(
    calls
      .filter((call) => call.method === 'turn/interrupt')
      .every((call) => call.params?.threadId !== thread.id),
  ).toBe(true);
  expect((await adapter.readThread(thread.id)).turns).toHaveLength(0);
});

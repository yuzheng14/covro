import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { parseConfig } from '../../src/server/config.js';
import { startGateway } from '../../src/server/main.js';
import { ProjectionCache } from '../../src/web/lib/realtime.js';
import type {
  Operation,
  ServerMessage,
  SystemInfo,
  ThreadSummary,
  ThreadView,
} from '../../src/shared/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  options: {
    confirmCompatibility?: boolean;
    unsupportedMethod?: string;
    origins?: (origin: string) => string[];
    multipleProjects?: boolean;
  } = {},
) {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), 'codex-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  if (options.multipleProjects) await mkdir(join(root, 'second'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><title>Codex test</title>');
  const origin = `http://127.0.0.1:${address.port}`;
  const origins = options.origins?.(origin) ?? [origin];
  const config = parseConfig(
    {
      port: address.port,
      publicOrigin: origins,
      dataDir: join(root, 'data'),
      projects: [
        { id: 'test', name: 'Test', path: join(root, 'project') },
        ...(options.multipleProjects
          ? [{ id: 'second', name: 'Second', path: join(root, 'second') }]
          : []),
      ],
    },
    join(root, 'config.json'),
  );
  const codex = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        turnDelayMs: 150,
        fragmentBytes: 11,
        unsupportedMethod: options.unsupportedMethod,
      }),
    ],
  });
  const runtime = await startGateway(config, { codex, staticDir: join(root, 'web') });
  cleanup.push(runtime.close);
  const post = async (path: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const connect = async (browserOrigin = origin, overview = false) => {
    const ws = new WebSocket(
      origin.replace('http:', 'ws:') + `/ws${overview ? '?overview=1' : ''}`,
      {
        origin: browserOrigin,
        headers: { host: new URL(browserOrigin).host },
      },
    );
    await once(ws, 'open');
    cleanup.push(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await once(ws, 'close');
      }
    });
    return ws;
  };
  if (options.confirmCompatibility !== false) {
    const system = (await (await fetch(`${origin}/api/system`)).json()) as SystemInfo;
    const confirmation = await post('/api/system/compatibility/confirm', {
      clientOperationId: randomUUID(),
      codexEpoch: system.codexEpoch,
      codexVersion: system.codexVersion,
      verifiedVersion: system.verifiedVersion,
      confirm: true,
    });
    expect(confirmation.status).toBe(200);
  }
  return { origin, origins, runtime, post, connect };
}
it('saves only a complete model pair through a durable operation and new threads inherit it', async () => {
  const { post, origin } = await setup();
  const previous = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const previousId = (previous.result as { threadId: string }).threadId;
  const input = {
    clientOperationId: randomUUID(),
    settings: { model: 'simulated-model', reasoningEffort: 'high' },
  };
  const response = await post('/api/projects/test/model-defaults', input);
  expect(response.status).toBe(200);
  const saved = (await response.json()) as Operation;
  expect(saved).toMatchObject({
    kind: 'config.modelDefaults',
    status: 'acknowledged',
    result: { status: 'ok' },
  });
  expect(saved.result).toEqual({ status: 'ok' });
  expect(await (await post('/api/projects/test/model-defaults', input)).json()).toEqual(saved);
  expect(
    (
      await post('/api/projects/test/model-defaults', {
        ...input,
        settings: { ...input.settings, reasoningEffort: 'low' },
      })
    ).status,
  ).toBe(409);
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const id = (created.result as { threadId: string }).threadId;
  expect(await (await fetch(`${origin}/api/threads/${id}`)).json()).toMatchObject({
    runtimeSettings: {
      model: 'simulated-model',
      reasoningEffort: 'high',
      permissionMode: 'read-only',
    },
  });
  expect(await (await fetch(`${origin}/api/threads/${previousId}`)).json()).toMatchObject({
    runtimeSettings: { reasoningEffort: 'medium' },
  });
});

it('rejects config paths, permission settings, incomplete pairs and unknown projects at the model defaults endpoint', async () => {
  const { post, origin } = await setup();
  const settings = { model: 'simulated-model', reasoningEffort: 'high' };
  for (const input of [
    { settings, filePath: '/tmp/other-config.toml' },
    { settings: { ...settings, permissionMode: 'full-access' } },
    { settings: { model: 'simulated-model' } },
    { settings: { model: 'missing', reasoningEffort: 'high' } },
  ])
    expect(
      (
        await post('/api/projects/test/model-defaults', {
          clientOperationId: randomUUID(),
          ...input,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await post('/api/projects/missing/model-defaults', {
        clientOperationId: randomUUID(),
        settings,
      })
    ).status,
  ).toBe(404);
  expect(await (await fetch(`${origin}/api/projects/test/runtime-settings`)).json()).toMatchObject({
    reasoningEffort: 'medium',
    sandbox: 'read-only',
  });
});

it('requires compatibility confirmation before writing model defaults', async () => {
  const { post, origin } = await setup({ confirmCompatibility: false });
  const response = await post('/api/projects/test/model-defaults', {
    clientOperationId: randomUUID(),
    settings: { model: 'simulated-model', reasoningEffort: 'high' },
  });
  expect(response.status).toBe(409);
  expect(await (await fetch(`${origin}/api/projects/test/runtime-settings`)).json()).toMatchObject({
    reasoningEffort: 'medium',
  });
});

// Simulate the Host and Origin preserved by an HTTP reverse proxy such as Tailscale Serve.
// These requests use a real loopback listener; they do not test a live Tailscale deployment.
function proxyRequest(
  origin: string,
  path: string,
  headers: { host: string; origin?: string },
  body?: object,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode!, text }));
        response.on('error', reject);
      },
    );
    request.setTimeout(3000, () => request.destroy(new Error('HTTP request timeout')));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function rejectedUpgrade(origin: string, headers: { host: string; origin: string }) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
      headers,
      handshakeTimeout: 3000,
    });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      ws.terminate();
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('Unexpected successful WebSocket upgrade'));
    });
    ws.on('error', reject);
  });
}
function message(
  ws: WebSocket,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', listener);
      reject(new Error('WS message timeout'));
    }, 5000);
    const listener = (data: Buffer) => {
      const value = JSON.parse(data.toString()) as ServerMessage;
      if (predicate(value)) {
        clearTimeout(timer);
        ws.off('message', listener);
        resolve(value);
      }
    };
    ws.on('message', listener);
  });
}
const multipleOrigins = (origin: string) => [
  origin,
  origin.replace('127.0.0.1', 'localhost'),
  'https://codex.example.ts.net',
];

it('hydrates incremental subscribers through an HTTP cursor and replays live changes', async () => {
  const { origin, post, connect } = await setup();
  const created = await post('/api/projects/test/threads', { clientOperationId: randomUUID() });
  const id = ((await created.json()) as Operation).result as { threadId: string };
  const ws = await connect(origin, true);
  const resync = message(ws, (event) => event.type === 'resync');
  ws.send(JSON.stringify({ type: 'subscribe', threadId: id.threadId, incremental: true }));
  expect(await resync).toMatchObject({ threadId: id.threadId });
  const response = await fetch(`${origin}/api/threads/${id.threadId}/snapshot`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const snapshot = (await response.json()) as {
    data: ThreadView;
    cursor: { serverEpoch: string; seq: number };
  };
  expect(snapshot.data.id).toBe(id.threadId);
  const cache = new ProjectionCache();
  cache.apply({ type: 'snapshot', threadId: id.threadId, ...snapshot });
  ws.on('message', (data: Buffer) => cache.apply(JSON.parse(data.toString()) as ServerMessage));
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      threadId: id.threadId,
      incremental: true,
      after: snapshot.cursor,
    }),
  );
  const completion = message(
    ws,
    (event) =>
      event.type === 'event' &&
      event.kind === 'threadPatch' &&
      (event.payload as import('../../src/shared/thread-patch.js').ThreadPatch).thread.status ===
        'completed',
  );
  await post(`/api/threads/${id.threadId}/turns`, {
    clientOperationId: randomUUID(),
    text: '通过增量完成任务',
  });
  await completion;
  expect(cache.get(id.threadId)!.data.turns[0]!.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'agentMessage', text: '模拟任务已完成。' }),
    ]),
  );
});

it('broadcasts other project summaries before selection and alongside one detailed subscription', async () => {
  const { origin, post, connect } = await setup({ multipleProjects: true });
  const initial = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const initialId = (initial.result as { threadId: string }).threadId;
  const selected = await connect(origin, true);
  const idle = await connect(origin, true);
  const legacy = await connect();
  const snapshot = message(selected, (event) => event.type === 'snapshot');
  selected.send(JSON.stringify({ type: 'subscribe', threadId: initialId }));
  await snapshot;
  const legacySnapshot = message(legacy, (event) => event.type === 'snapshot');
  legacy.send(JSON.stringify({ type: 'subscribe', threadId: initialId }));
  await legacySnapshot;
  const legacyMessages: ServerMessage[] = [];
  legacy.on('message', (data: Buffer) =>
    legacyMessages.push(JSON.parse(data.toString()) as ServerMessage),
  );
  const received: ServerMessage[][] = [[], []];
  [selected, idle].forEach((ws, index) =>
    ws.on('message', (data: Buffer) =>
      received[index]!.push(JSON.parse(data.toString()) as ServerMessage),
    ),
  );
  const summary = (status: ThreadSummary['status']) => (event: ServerMessage) =>
    event.type === 'event' &&
    event.kind === 'threadSummary' &&
    (event.payload as ThreadSummary).projectId === 'second' &&
    (event.payload as ThreadSummary).status === status;
  const creation = message(
    idle,
    (event) =>
      summary('idle')(event) && event.type === 'event' && (event.payload as ThreadSummary).managed,
  );
  const created = (await (
    await post('/api/projects/second/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const secondId = (created.result as { threadId: string }).threadId;
  expect(await creation).toMatchObject({ threadId: secondId });
  const waitingApproval = (event: ServerMessage) =>
    summary('waitingApproval')(event) &&
    event.type === 'event' &&
    (event.payload as ThreadSummary).pendingActionCount === 1;
  const approvals = [selected, idle].map((ws) => message(ws, waitingApproval));
  const titles = [selected, idle].map((ws) =>
    message(
      ws,
      (event) =>
        waitingApproval(event) &&
        event.type === 'event' &&
        (event.payload as ThreadSummary).title === 'Codex 配置继承与运行设置',
    ),
  );
  await post(`/api/threads/${secondId}/turns`, {
    clientOperationId: randomUUID(),
    text: '[approval] private request body',
  });
  for (const result of await Promise.all(approvals))
    expect(result).toMatchObject({ payload: { pendingActionCount: 1 } });
  await Promise.all(titles);
  const detail = (await (await fetch(`${origin}/api/threads/${secondId}`)).json()) as ThreadView;
  const action = detail.actions[0]!;
  const completions = [selected, idle].map((ws) => message(ws, summary('completed')));
  await post(`/api/actions/${action.actionId}/resolve`, {
    clientOperationId: randomUUID(),
    resolution: { decision: action.options[0]!.id },
  });
  await Promise.all(completions);
  expect(
    legacyMessages.some((event) => event.type === 'event' && event.kind === 'threadSummary'),
  ).toBe(false);
  expect(legacyMessages.some((event) => event.type === 'event' && event.kind === 'operation')).toBe(
    true,
  );
  for (const events of received) {
    const approvalSummaries = events.filter(waitingApproval);
    expect(approvalSummaries.length).toBeGreaterThanOrEqual(1);
    // A title refresh can change the summary while approval remains pending.
    expect(
      new Set(
        approvalSummaries.map((event) => event.type === 'event' && JSON.stringify(event.payload)),
      ).size,
    ).toBe(approvalSummaries.length);
    expect(approvalSummaries.at(-1)).toMatchObject({
      payload: { title: 'Codex 配置继承与运行设置' },
    });
    expect(events.filter(summary('completed'))).toHaveLength(1);
    expect(events.some((event) => event.type === 'event' && event.kind === 'threadPatch')).toBe(
      false,
    );
    const summaries = events.filter(
      (event) => event.type === 'event' && event.kind === 'threadSummary',
    );
    for (const event of summaries) {
      if (event.type !== 'event') throw new Error('Expected summary event');
      expect(event.payload).not.toHaveProperty('turns');
      expect(event.payload).not.toHaveProperty('actions');
      expect(event.payload).not.toHaveProperty('cwd');
      // Upstream preview is intentionally visible as the title; conversation content
      // must not be included in any of the remaining overview fields.
      const { title: _title, ...metadata } = event.payload as ThreadSummary;
      expect(JSON.stringify(metadata)).not.toContain('private request body');
    }
  }
  const overview = await fetch(`${origin}/api/projects/second/threads`);
  expect(overview.status).toBe(200);
  expect(await overview.json()).toMatchObject({
    data: [{ id: secondId, lastTurnStatus: 'completed', pendingActionCount: 0 }],
  });
});

it('validates unsubscribe and releases detail delivery while keeping overview and runtime active', async () => {
  const { origin, runtime, post, connect } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const threadId = (created.result as { threadId: string }).threadId;
  const ws = await connect(origin, true);
  const invalid = message(ws, (event) => event.type === 'error');
  ws.send(JSON.stringify({ type: 'unsubscribe', threadId }));
  expect(await invalid).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  const snapshot = message(ws, (event) => event.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  await snapshot;
  const received: ServerMessage[] = [];
  ws.on('message', (data: Buffer) => received.push(JSON.parse(data.toString()) as ServerMessage));
  ws.send(JSON.stringify({ type: 'unsubscribe' }));
  // A pong after this frame is a transport barrier: the server has processed unsubscribe.
  const pong = once(ws, 'pong');
  ws.ping();
  await pong;
  const completed = message(
    ws,
    (event) =>
      event.type === 'event' &&
      event.kind === 'threadSummary' &&
      (event.payload as ThreadSummary).lastTurnStatus === 'completed',
  );
  await post(`/api/threads/${threadId}/turns`, {
    clientOperationId: randomUUID(),
    text: 'continue after leaving detail',
  });
  await completed;
  const runtimeEvent = message(ws, (event) => event.type === 'event' && event.kind === 'runtime');
  runtime.service.events.publish('runtime', runtime.service.getSystem());
  await runtimeEvent;
  expect(received.some((event) => event.type === 'error')).toBe(false);
  expect(received.some((event) => event.type === 'event' && event.kind === 'threadPatch')).toBe(
    false,
  );
  expect(received.some((event) => event.type === 'event' && event.kind === 'threadSummary')).toBe(
    true,
  );
  const refreshed = message(ws, (event) => event.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  expect(await refreshed).toMatchObject({ data: { turns: [{ status: 'completed' }] } });
});

it('serves every configured origin through one HTTP gateway and shared WebSocket execution', async () => {
  const { origin, origins, runtime, connect } = await setup({ origins: multipleOrigins });
  const pid = runtime.codex.pid;
  const create = vi.spyOn(runtime.codex, 'createThread');
  const threadIds: string[] = [];
  for (const browserOrigin of origins) {
    const headers = { host: new URL(browserOrigin).host, origin: browserOrigin };
    const page = await proxyRequest(origin, '/', { host: headers.host });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Codex test');
    const system = await proxyRequest(origin, '/api/system', headers);
    expect(system.status).toBe(200);
    expect(JSON.parse(system.text)).toMatchObject({
      codexEpoch: runtime.service.getSystem().codexEpoch,
      compatibilityConfirmation: 'confirmed',
    });
    const projects = await proxyRequest(origin, '/api/projects', headers);
    expect(projects.status).toBe(200);
    expect(JSON.parse(projects.text)).toMatchObject({ data: [{ id: 'test' }] });
    const created = await proxyRequest(origin, '/api/projects/test/threads', headers, {
      clientOperationId: randomUUID(),
    });
    expect(created.status).toBe(200);
    const operation = JSON.parse(created.text) as Operation;
    expect(operation.status).toBe('acknowledged');
    threadIds.push((operation.result as { threadId: string }).threadId);
  }
  expect(create).toHaveBeenCalledTimes(3);
  expect(new Set(threadIds).size).toBe(3);
  const threadId = threadIds[0]!;
  const sockets = await Promise.all(origins.map((browserOrigin) => connect(browserOrigin)));
  for (const ws of sockets) {
    const snapshot = message(ws, (event) => event.type === 'snapshot');
    ws.send(JSON.stringify({ type: 'subscribe', threadId }));
    expect(await snapshot).toMatchObject({ type: 'snapshot', data: { id: threadId } });
  }
  const completions = sockets.map((ws) =>
    message(ws, (event) => {
      if (event.type !== 'event' || event.kind !== 'threadPatch') return false;
      const patch = event.payload as import('../../src/shared/thread-patch.js').ThreadPatch;
      return patch.thread.id === threadId && patch.turns[0]?.turn.status === 'completed';
    }),
  );
  const browserOrigin = origins[2]!;
  const started = await proxyRequest(
    origin,
    `/api/threads/${threadId}/turns`,
    { host: new URL(browserOrigin).host, origin: browserOrigin },
    { clientOperationId: randomUUID(), text: '跨入口查看同一个任务' },
  );
  expect(started.status).toBe(200);
  await Promise.all(completions);
  for (const browserOrigin of origins) {
    const response = await proxyRequest(origin, `/api/threads/${threadId}`, {
      host: new URL(browserOrigin).host,
      origin: browserOrigin,
    });
    expect(response.status).toBe(200);
    const thread = JSON.parse(response.text) as ThreadView;
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]?.status).toBe('completed');
  }
  expect(runtime.codex.pid).toBe(pid);
});

it('rejects unconfigured hosts, origins and ports for HTTP pages, APIs and WebSocket upgrades', async () => {
  const { origin, runtime } = await setup({ origins: multipleOrigins });
  const host = new URL(origin).host;
  const cases = [
    { host: 'unconfigured.example.ts.net', origin, code: 'INVALID_HOST' },
    { host: `${new URL(origin).hostname}:1`, origin, code: 'INVALID_HOST' },
    { host: 'codex.example.ts.net:444', origin, code: 'INVALID_HOST' },
    { host, origin: 'https://unconfigured.example.ts.net', code: 'INVALID_ORIGIN' },
    { host, origin: 'http://127.0.0.1:1', code: 'INVALID_ORIGIN' },
    { host, origin: 'https://codex.example.ts.net:444', code: 'INVALID_ORIGIN' },
  ];
  const create = vi.spyOn(runtime.codex, 'createThread');
  for (const { code, ...headers } of cases) {
    for (const path of ['/', '/api/projects']) {
      const response = await proxyRequest(origin, path, headers);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toMatchObject({ error: { code } });
    }
    const response = await proxyRequest(origin, '/api/projects/test/threads', headers, {
      clientOperationId: randomUUID(),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({ error: { code } });
    expect(await rejectedUpgrade(origin, headers)).toBe(403);
  }
  expect(create).not.toHaveBeenCalled();
});

it('accepts image bodies above the old text limit and includes images in operation identity', async () => {
  const { post, runtime } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const threadId = (created.result as { threadId: string }).threadId;
  const images = [`data:image/png;base64,${Buffer.alloc(400 * 1024).toString('base64')}`];
  const input = { clientOperationId: randomUUID(), text: '', images };
  const spy = vi.spyOn(runtime.codex, 'startTurn');
  const response = await post(`/api/threads/${threadId}/turns`, input);
  expect(response.status).toBe(200);
  expect(spy.mock.calls[0]?.[4]).toEqual(images);
  expect((await (await post(`/api/threads/${threadId}/turns`, input)).json()).status).toBe(
    'acknowledged',
  );
  const conflict = await post(`/api/threads/${threadId}/turns`, {
    ...input,
    images: ['data:image/png;base64,aGVsbG8='],
  });
  expect(conflict.status).toBe(409);
  const invalid = await post(`/api/threads/${threadId}/turns`, {
    ...input,
    clientOperationId: randomUUID(),
    images: ['file:///tmp/image.png'],
  });
  expect(invalid.status).toBe(400);
  expect(spy).toHaveBeenCalledTimes(1);
});

it('runs through HTTP, survives all sockets closing, and reconnects from a snapshot with real IDs', async () => {
  const { origin, runtime, post, connect } = await setup();
  const createResponse = await post('/api/projects/test/threads', {
    clientOperationId: randomUUID(),
  });
  expect(createResponse.status).toBe(200);
  const create = (await createResponse.json()) as Operation;
  const threadId = (create.result as { threadId: string }).threadId;
  const ws = await connect();
  const first = message(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  expect((await first).type).toBe('snapshot');
  const pid = runtime.codex.pid;
  const opId = randomUUID();
  const input = { clientOperationId: opId, text: '测试 HTTP 与恢复' };
  const [a, b] = await Promise.all([
    post(`/api/threads/${threadId}/turns`, input),
    post(`/api/threads/${threadId}/turns`, input),
  ]);
  expect([200, 202]).toContain(a.status);
  expect([200, 202]).toContain(b.status);
  ws.close();
  await once(ws, 'close');
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).turns[0]
          ?.status,
    )
    .toBe('completed');
  expect(runtime.codex.pid).toBe(pid);
  const reopened = await connect();
  const snapshot = message(reopened, (m) => m.type === 'snapshot');
  reopened.send(JSON.stringify({ type: 'subscribe', threadId }));
  const restored = await snapshot;
  if (restored.type !== 'snapshot') throw new Error('Expected snapshot');
  expect(restored.data.turns).toHaveLength(1);
  expect(restored.data.turns[0]?.items.some((i) => i.text === '模拟任务已完成。')).toBe(true);
  const conflict = await post(`/api/threads/${threadId}/turns`, { ...input, text: '不同请求' });
  expect(conflict.status).toBe(409);
});
it('rejects foreign origin before upgrade, validates JSON, and never serves SPA HTML for missing API/assets', async () => {
  const { origin, post } = await setup();
  const denied = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://attacker.test',
  });
  const rejected = await new Promise<number>((resolve, reject) => {
    denied.once('unexpected-response', (_req, res) => {
      const code = res.statusCode!;
      res.resume();
      denied.terminate();
      resolve(code);
    });
    denied.on('error', () => {});
    setTimeout(() => reject(new Error('No rejection')), 3000).unref();
  });
  expect(rejected).toBe(403);
  const wrong = await post('/api/projects/test/threads', {
    clientOperationId: randomUUID(),
    cwd: '/tmp',
  });
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).error.code).toBe('VALIDATION_FAILED');
  for (const path of ['/api/missing', '/ws/missing', '/assets/missing.js']) {
    const response = await fetch(origin + path, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  }
  const navigation = await fetch(origin + '/thread/any', { headers: { accept: 'text/html' } });
  expect(navigation.status).toBe(200);
  expect(await navigation.text()).toContain('Codex test');
});
it('restores pending approval and accepts exactly one competing decision', async () => {
  const { origin, post, connect } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const threadId = (created.result as { threadId: string }).threadId;
  await post(`/api/threads/${threadId}/turns`, {
    clientOperationId: randomUUID(),
    text: '[approval]',
  });
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).actions
          .length,
    )
    .toBe(1);
  const ws = await connect();
  const pending = message(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  const snapshot = await pending;
  if (snapshot.type !== 'snapshot') throw new Error('snapshot');
  const action = snapshot.data.actions[0]!;
  expect(action.rpcId).toBe(0);
  expect(action.status).toBe('pending');
  const results = await Promise.all([
    post(`/api/actions/${action.actionId}/resolve`, {
      clientOperationId: randomUUID(),
      resolution: { decision: action.options[0]!.id },
    }),
    post(`/api/actions/${action.actionId}/resolve`, {
      clientOperationId: randomUUID(),
      resolution: { decision: action.options[0]!.id },
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).turns[0]
          ?.status,
    )
    .toBe('completed');
});

it('forks a busy conversation over HTTP, restores its history over WebSocket, and executes both conversations independently', async () => {
  const { origin, post, connect, runtime } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const sourceId = (created.result as { threadId: string }).threadId;
  await post(`/api/threads/${sourceId}/turns`, {
    clientOperationId: randomUUID(),
    text: '[approval]',
  });
  const read = async (id: string) =>
    (await (await fetch(`${origin}/api/threads/${id}`)).json()) as ThreadView;
  await expect.poll(async () => (await read(sourceId)).actions.length).toBe(1);
  await expect.poll(async () => (await read(sourceId)).title).toBe('Codex 配置继承与运行设置');
  const source = await read(sourceId);
  const fork = vi.spyOn(runtime.codex, 'forkThread');
  const input = { clientOperationId: randomUUID() };
  const response = await post(`/api/threads/${sourceId}/fork`, input);
  expect(response.status).toBe(200);
  const operation = (await response.json()) as Operation;
  expect(operation).toMatchObject({
    kind: 'thread.fork',
    target: sourceId,
    status: 'acknowledged',
    result: { forkedFromId: sourceId },
  });
  const forkId = (operation.result as { threadId: string }).threadId;
  expect(forkId).not.toBe(sourceId);
  expect(await (await post(`/api/threads/${sourceId}/fork`, input)).json()).toEqual(operation);
  expect(await (await fetch(`${origin}/api/operations/${input.clientOperationId}`)).json()).toEqual(
    operation,
  );
  expect(fork).toHaveBeenCalledTimes(1);
  expect(await read(sourceId)).toEqual(source);
  const ws = await connect();
  const snapshot = message(ws, (event) => event.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId: forkId }));
  expect(await snapshot).toMatchObject({
    type: 'snapshot',
    data: {
      id: forkId,
      forkedFromId: sourceId,
      managed: true,
      actions: [],
      turns: [{ threadId: forkId, status: 'interrupted' }],
    },
  });
  const continued = await post(`/api/threads/${forkId}/turns`, {
    clientOperationId: randomUUID(),
    text: '[approval] new branch',
  });
  expect(continued.status).toBe(200);
  await expect.poll(async () => (await read(forkId)).status).toBe('waitingApproval');
  expect((await read(sourceId)).status).toBe('waitingApproval');
  const action = source.actions[0]!;
  await post(`/api/actions/${action.actionId}/resolve`, {
    clientOperationId: randomUUID(),
    resolution: { decision: action.options[0]!.id },
  });
  await expect.poll(async () => (await read(sourceId)).turns[0]?.status).toBe('completed');
  const branch = await read(forkId);
  expect(branch.status).toBe('waitingApproval');
  const branchAction = branch.actions.find((entry) => entry.status === 'pending')!;
  expect(branchAction.actionId).not.toBe(action.actionId);
  await post(`/api/actions/${branchAction.actionId}/resolve`, {
    clientOperationId: randomUUID(),
    resolution: { decision: branchAction.options[0]!.id },
  });
  await expect.poll(async () => (await read(forkId)).turns[1]?.status).toBe('completed');
  expect((await read(sourceId)).turns).toHaveLength(1);
  expect((await read(forkId)).turns).toHaveLength(2);
});

it('validates fork bodies and rejects foreign origins before calling the upstream fork', async () => {
  const { origin, post, runtime } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const sourceId = (created.result as { threadId: string }).threadId;
  const path = `/api/threads/${sourceId}/fork`;
  const fork = vi.spyOn(runtime.codex, 'forkThread');
  for (const body of [
    {},
    { clientOperationId: 'invalid' },
    { clientOperationId: randomUUID(), cwd: '/tmp' },
    { clientOperationId: randomUUID(), settings: { cwd: '/tmp' } },
    { clientOperationId: randomUUID(), confirmExternalStopped: true },
  ]) {
    const response = await post(path, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  }
  const rejected = await fetch(origin + path, {
    method: 'POST',
    headers: { origin: 'https://foreign.test', 'content-type': 'application/json' },
    body: JSON.stringify({ clientOperationId: randomUUID() }),
  });
  expect(rejected.status).toBe(403);
  expect(await rejected.json()).toMatchObject({ error: { code: 'INVALID_ORIGIN' } });
  expect(fork).not.toHaveBeenCalled();
});

it('fails migrations before launching Codex and releases the instance lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-migration-fail-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await cp(resolve('drizzle'), join(root, 'migrations'), { recursive: true });
  const sql = (await readdir(join(root, 'migrations'))).find((name) => name.endsWith('.sql'))!;
  await writeFile(join(root, 'migrations', sql), 'THIS IS NOT SQL;');
  const config = parseConfig(
    {
      dataDir: join(root, 'data'),
      projects: [{ id: 'test', name: 'Test', path: join(root, 'project') }],
    },
    join(root, 'config.json'),
  );
  const codex = new CodexAdapter({
    binary: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtures/app-server.ts'), '--options', '{}'],
  });
  const start = vi.spyOn(codex, 'start');
  await expect(
    startGateway(config, { codex, migrationsDir: join(root, 'migrations') }),
  ).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
  const { acquireInstanceLock } = await import('../../src/server/instance-lock.js');
  const release = await acquireInstanceLock(config.dataDir);
  await release();
});

it('requires explicit compatibility confirmation, audits retries and broadcasts consent to both tabs', async () => {
  const { origin, runtime, post, connect } = await setup({ confirmCompatibility: false });
  const info = (await (await fetch(`${origin}/api/system`)).json()) as SystemInfo;
  expect(info).toMatchObject({
    ready: true,
    compatibility: 'unverified',
    compatibilityConfirmation: 'required',
  });
  const create = vi.spyOn(runtime.codex, 'createThread');
  const blockedId = randomUUID();
  const blocked = await post('/api/projects/test/threads', { clientOperationId: blockedId });
  expect(blocked.status).toBe(409);
  expect((await blocked.json()).error).toMatchObject({
    code: 'COMPATIBILITY_CONFIRMATION_REQUIRED',
    clientOperationId: blockedId,
  });
  expect(create).not.toHaveBeenCalled();
  expect(await (await fetch(`${origin}/api/operations/${blockedId}`)).json()).toMatchObject({
    status: 'failed',
  });
  expect((await fetch(`${origin}/api/projects`)).status).toBe(200);
  const firstTab = await connect();
  const secondTab = await connect();
  const firstUpdate = message(
    firstTab,
    (event) => event.type === 'event' && event.kind === 'runtime',
  );
  const secondUpdate = message(
    secondTab,
    (event) => event.type === 'event' && event.kind === 'runtime',
  );
  const input = {
    clientOperationId: randomUUID(),
    codexEpoch: info.codexEpoch,
    codexVersion: info.codexVersion,
    verifiedVersion: info.verifiedVersion,
    confirm: true,
  };
  const response = await post('/api/system/compatibility/confirm', input);
  expect(response.status).toBe(200);
  const operation = (await response.json()) as Operation;
  expect(operation).toMatchObject({
    status: 'acknowledged',
    result: { compatibilityConfirmation: 'confirmed' },
  });
  expect(await firstUpdate).toMatchObject({
    payload: { compatibility: 'unverified', compatibilityConfirmation: 'confirmed' },
  });
  expect(await secondUpdate).toMatchObject({ payload: { compatibilityConfirmation: 'confirmed' } });
  expect(await (await post('/api/system/compatibility/confirm', input)).json()).toEqual(operation);
  expect(await (await fetch(`${origin}/api/operations/${input.clientOperationId}`)).json()).toEqual(
    operation,
  );
  expect(
    (await post('/api/projects/test/threads', { clientOperationId: randomUUID() })).status,
  ).toBe(200);
  expect(create).toHaveBeenCalledTimes(1);
});

it('rejects stale fingerprints, invalid confirmation bodies, foreign origins and unavailable runtime', async () => {
  const { origin, runtime, post } = await setup({ confirmCompatibility: false });
  const info = runtime.service.getSystem();
  const input = {
    clientOperationId: randomUUID(),
    codexEpoch: info.codexEpoch,
    codexVersion: info.codexVersion,
    verifiedVersion: info.verifiedVersion,
    confirm: true,
  };
  const stale = await post('/api/system/compatibility/confirm', {
    ...input,
    verifiedVersion: 'stale',
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe('COMPATIBILITY_CHANGED');
  for (const invalid of [
    { ...input, confirm: false },
    { ...input, confirm: undefined },
    { ...input, extra: true },
  ]) {
    const response = await post('/api/system/compatibility/confirm', invalid);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  }
  const foreign = await fetch(`${origin}/api/system/compatibility/confirm`, {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(foreign.status).toBe(403);
  const current = runtime.codex.diagnostics();
  const spy = vi
    .spyOn(runtime.codex, 'diagnostics')
    .mockReturnValue({ ...current, compatibility: 'unavailable' });
  const unavailable = await post('/api/system/compatibility/confirm', {
    ...input,
    clientOperationId: randomUUID(),
  });
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error.code).toBe('CODEX_UNAVAILABLE');
  spy.mockRestore();
  expect(runtime.service.getSystem().compatibilityConfirmation).toBe('required');
});

it('does not override an explicitly unsupported upstream method after compatibility is confirmed', async () => {
  const { runtime, post } = await setup({ unsupportedMethod: 'thread/start' });
  const first = await post('/api/projects/test/threads', { clientOperationId: randomUUID() });
  expect((await first.json()).error.code).toBe('PROTOCOL_INCOMPATIBLE');
  const current = runtime.service.getSystem();
  expect(current.capabilities).not.toContain('thread/start');
  const confirmedAgain = await post('/api/system/compatibility/confirm', {
    clientOperationId: randomUUID(),
    codexEpoch: current.codexEpoch,
    codexVersion: current.codexVersion,
    verifiedVersion: current.verifiedVersion,
    confirm: true,
  });
  expect(confirmedAgain.status).toBe(200);
  const rejected = await post('/api/projects/test/threads', { clientOperationId: randomUUID() });
  expect((await rejected.json()).error.code).toBe('PROTOCOL_INCOMPATIBLE');
  expect(runtime.service.getSystem().capabilities).not.toContain('thread/start');
});

it('returns only displayable runtime defaults for registered projects and rejects arbitrary project paths', async () => {
  const { origin } = await setup();
  const response = await fetch(`${origin}/api/projects/test/runtime-settings`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    model: 'simulated-model',
    reasoningEffort: 'medium',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalReviewer: 'user',
  });
  expect(body).not.toHaveProperty('api_key');
  expect(body).not.toHaveProperty('developer_instructions');
  expect((await fetch(`${origin}/api/projects/unknown/runtime-settings`)).status).toBe(404);
});

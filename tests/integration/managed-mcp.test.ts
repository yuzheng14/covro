import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ManagedMcpCalls, type ManagedLoopTool } from '../../src/codex/managed-mcp.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { Operation } from '../../src/shared/types.js';
import type { SessionLoop } from '../../src/shared/session-loop.js';
import { GatewayService } from '../../src/server/service.js';
import { captureLogger } from '../fixtures/logging.js';
import { startManagedMcp } from '../../src/server/mcp/server.js';
import { harness, operationId } from './domain-helpers.js';
import { AppError } from '../../src/shared/errors.js';
import { request as httpRequest } from 'node:http';
import { startGateway } from '../../src/server/main.js';
import { parseConfig } from '../../src/server/config.js';
import { join } from 'node:path';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(logger?: ReturnType<typeof captureLogger>['logger']) {
  const ctx = harness(logger);
  cleanup.push(ctx.close);
  const mcp = await startManagedMcp({
    service: () => ctx.service,
    publicOrigin: 'http://127.0.0.1:8787',
    logger,
  });
  cleanup.push(mcp.close);
  const client = new Client({ name: 'covro-test', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
  return { ...ctx, mcp, client };
}

it('supports standard MCP discovery without authentication and advertises exactly the confirmed tools', async () => {
  const { client, mcp } = await setup();
  expect(mcp.name).toMatch(/^covro_[a-f0-9]{32}$/);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(['list_projects', 'create_session']);
  expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
  expect(tools[1]!.inputSchema.required).toEqual(['project_id', 'prompt']);
  expect(tools[1]!.inputSchema.additionalProperties).toBe(false);
  const reply = await client.callTool({ name: 'list_projects', arguments: {} });
  expect(reply.structuredContent).toMatchObject({
    projects: [{ project_id: 'project', name: '测试项目', available: true }],
  });
  expect(reply.content).toEqual([{ type: 'text', text: JSON.stringify(reply.structuredContent) }]);
});

it('creates and submits through the gateway, forwarding Codex metadata for durable deduplication', async () => {
  const { client, service, codex } = await setup();
  const params = {
    name: 'create_session',
    arguments: { project_id: 'project', prompt: 'Complete the initial task' },
    _meta: { threadId: 'calling-thread', callId: 'calling-tool' },
  };
  const reply = await client.callTool(params);
  expect(reply).toMatchObject({
    structuredContent: {
      status: 'acknowledged',
      stage: 'submitted',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
    },
  });
  expect(await client.callTool(params)).toEqual(reply);
  expect(codex.creates).toBe(1);
  expect(codex.starts).toBe(1);
  expect(await service.getThread('thread-1')).toMatchObject({
    managed: true,
    historyVisible: true,
    status: 'running',
  });
});

it('validates required prompts and project-only inputs before creating anything', async () => {
  const { client, codex } = await setup();
  for (const args of [
    { project_id: 'project' },
    { project_id: 'project', prompt: ' \n\t ' },
    { project_id: 'project', prompt: 'Task', cwd: '/' },
  ])
    expect(await client.callTool({ name: 'create_session', arguments: args })).toMatchObject({
      isError: true,
    });
  expect(codex.creates).toBe(0);
});

it('returns partial creation receipts on failures and rejects changed input for an existing retry key', async () => {
  const { client, codex } = await setup();
  vi.spyOn(codex, 'startTurn').mockRejectedValue(new AppError('REJECTED', 'Rejected prompt', 400));
  const args = { project_id: 'project', prompt: 'Task', request_key: operationId() };
  const reply = await client.callTool({ name: 'create_session', arguments: args });
  expect(reply).toMatchObject({
    isError: true,
    structuredContent: {
      status: 'failed',
      thread_id: 'thread-1',
      stage: 'created',
      error: { code: 'REJECTED' },
    },
  });
  expect(await client.callTool({ name: 'create_session', arguments: args })).toEqual(reply);
  expect(
    await client.callTool({ name: 'create_session', arguments: { ...args, prompt: 'Other task' } }),
  ).toMatchObject({ isError: true, structuredContent: { error: { code: 'OPERATION_CONFLICT' } } });
  expect(codex.creates).toBe(1);
});

it('retains local Host/Origin and body protections while allowing native clients without Origin', async () => {
  const { mcp, codex } = await setup();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  expect((await fetch(mcp.url, { method: 'POST', headers, body })).status).toBe(200);
  expect(
    (
      await fetch(mcp.url, {
        method: 'POST',
        headers: { ...headers, origin: 'https://attacker.example' },
        body,
      })
    ).status,
  ).toBe(403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      mcp.url,
      { method: 'POST', headers: { ...headers, host: 'attacker.example' } },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end(body);
  });
  expect(hostStatus).toBe(403);
  expect(
    (
      await fetch(mcp.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body,
      })
    ).status,
  ).toBe(415);
  expect(
    (await fetch(mcp.url, { method: 'POST', headers, body: 'x'.repeat(512 * 1024 + 1) })).status,
  ).toBe(413);
  expect((await fetch(mcp.url)).status).toBe(405);
  expect((await fetch(mcp.url.replace('/mcp', '/api/projects'))).status).toBe(404);
  expect(codex.creates).toBe(0);
});

it('does not allow a tool to bypass compatibility confirmation or maintenance', async () => {
  const { client, codex, service } = await setup();
  codex.compatibility = 'unverified';
  expect(
    await client.callTool({
      name: 'create_session',
      arguments: { project_id: 'project', prompt: 'Task', request_key: operationId() },
    }),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' } },
  });
  codex.compatibility = 'verified';
  service.setMaintenance(true);
  expect(
    await client.callTool({
      name: 'create_session',
      arguments: { project_id: 'project', prompt: 'Task', request_key: operationId() },
    }),
  ).toMatchObject({ isError: true, structuredContent: { error: { code: 'UPDATE_MAINTENANCE' } } });
  expect(codex.creates).toBe(0);
});

it('rejects calls before the gateway is bound and closes the listener idempotently', async () => {
  const mcp = await startManagedMcp({
    service: () => undefined,
    publicOrigin: 'http://127.0.0.1:8787',
  });
  cleanup.push(mcp.close);
  expect(
    (
      await fetch(mcp.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(503);
  await Promise.all([mcp.close(), mcp.close()]);
  await expect(fetch(mcp.url)).rejects.toThrow();
});

it('binds the endpoint to the gateway lifecycle without exposing it on browser HTTP routes', async () => {
  const ctx = harness();
  cleanup.push(ctx.close);
  const config = parseConfig(
    {
      dataDir: join(ctx.directory, 'gateway'),
      projects: [{ id: 'project', name: 'Project', path: ctx.project }],
    },
    join(ctx.directory, 'config.json'),
  );
  const runtime = await startGateway({ ...config, port: 0 }, { codex: ctx.codex });
  cleanup.push(runtime.close);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  expect(
    (
      await fetch(runtime.mcp.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await runtime.app.request('http://127.0.0.1:8787/mcp', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(404);
  await runtime.close();
  await expect(fetch(runtime.mcp.url)).rejects.toThrow();
});

async function setupLoops() {
  const logging = captureLogger();
  const ctx = await setup(logging.logger);
  const client = new Client({ name: 'managed-codex-test', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ctx.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${ctx.mcp.token}` } },
    }),
  );
  const registry = new ManagedMcpCalls();
  Object.assign(ctx.codex, { managedLoopCall: registry.match.bind(registry) });

  async function startSession() {
    const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
    const { threadId } = created.result as { threadId: string };
    const saved = await ctx.service.startTurn(threadId, {
      clientOperationId: operationId(),
      text: 'Save thread',
    });
    ctx.codex.complete(threadId, (saved.result as { turnId: string }).turnId);
    const active = await ctx.service.startTurn(threadId, {
      clientOperationId: operationId(),
      text: 'Manage loops',
    });
    return { threadId, turnId: (active.result as { turnId: string }).turnId };
  }
  const session = await startSession();
  const other = await startSession();

  function observe(
    owner: typeof session,
    callId: string,
    tool: ManagedLoopTool,
    args: Record<string, string | number>,
    state?: { started?: boolean; server?: string },
  ) {
    const item: ThreadItem = {
      id: callId,
      type: 'mcpToolCall',
      server: state?.server ?? ctx.mcp.name,
      tool,
      status: 'inProgress',
      arguments: args,
      environmentId: null,
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
    registry.observe(ctx.mcp.name, owner.threadId, owner.turnId, item, state?.started ?? true);
  }
  function call(
    name: ManagedLoopTool,
    args: Record<string, string | number> = {},
    owner = session,
    callId = operationId(),
  ) {
    observe(owner, callId, name, args);
    return client.callTool({ name, arguments: args, _meta: { threadId: owner.threadId, callId } });
  }
  return {
    ...ctx,
    session,
    other,
    managed: client,
    registry,
    observe,
    call,
    records: logging.records,
  };
}

function mutationReceipt(reply: Awaited<ReturnType<Client['callTool']>>) {
  const body = reply.structuredContent as {
    status: string;
    request_key: string;
    operation_id: string;
    loop: SessionLoop;
  };
  expect(body?.status).toBe('acknowledged');
  return body;
}

it('exposes loop tools only to the owned transport and verifies a live turn, server, tool and arguments', async () => {
  const { client, managed, mcp, observe, session, other, service, codex, records } =
    await setupLoops();
  expect((await managed.listTools()).tools.map((tool) => tool.name)).toEqual([
    'list_projects',
    'create_session',
    'list_loops',
    'create_loop',
    'update_loop',
  ]);
  const args = { prompt: 'Confidential loop prompt', interval_minutes: 60 };
  const callId = operationId();
  const params = {
    name: 'create_loop',
    arguments: args,
    _meta: { threadId: session.threadId, callId },
  };
  observe(session, callId, 'create_loop', args, { server: 'unrelated' });
  const forbidden = {
    isError: true,
    structuredContent: { error: { code: 'MCP_SESSION_REQUIRED' } },
  };
  expect(await managed.callTool(params)).toMatchObject(forbidden);
  observe(session, callId, 'create_loop', args);
  expect(await client.callTool(params)).toMatchObject({ isError: true });
  const mismatches = await Promise.all([
    managed.callTool({ ...params, _meta: { threadId: other.threadId, callId } }),
    managed.callTool({ ...params, arguments: { ...args, interval_minutes: 5 } }),
    managed.callTool({ ...params, name: 'list_loops', arguments: {} }),
  ]);
  for (const mismatch of mismatches) expect(mismatch).toMatchObject(forbidden);
  expect(await service.listSessionLoops(session.threadId)).toEqual([]);
  expect(await service.listSessionLoops(other.threadId)).toEqual([]);

  const receipt = await managed.callTool(params);
  expect(receipt).toMatchObject({
    structuredContent: {
      status: 'acknowledged',
      loop: { threadId: session.threadId, intervalMs: 3_600_000 },
    },
  });
  expect(await managed.callTool(params)).toEqual(receipt);
  const operationIdFromTool = mutationReceipt(receipt).operation_id;
  expect(service.getOperation(operationIdFromTool)).toMatchObject({ kind: 'loop.create.mcp' });
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'operation.acknowledged',
      kind: 'loop.create.mcp',
      threadId: session.threadId,
      turnId: session.turnId,
      operationId: operationIdFromTool,
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'mcp.loop_context_rejected',
      errorCode: 'MCP_SESSION_REQUIRED',
    }),
  );
  expect(JSON.stringify(records)).not.toContain(args.prompt);
  expect(JSON.stringify(records)).not.toContain(mcp.token);

  observe(session, callId, 'create_loop', args, { started: false });
  expect(await managed.callTool(params)).toMatchObject(forbidden);
  observe(session, callId, 'create_loop', args);
  codex.complete(session.threadId, session.turnId);
  expect(await managed.callTool(params)).toMatchObject(forbidden);
  expect(await service.listSessionLoops(session.threadId)).toHaveLength(1);
});

it('shares version checks and persisted loop state with the browser and keeps the current turn running', async () => {
  const { call, service, session, other, codex, store, projects } = await setupLoops();
  const created = await call('create_loop', { prompt: 'Check CI', interval_minutes: 5 });
  const loop = mutationReceipt(created).loop;
  expect((await call('list_loops')).structuredContent).toEqual({ loops: [loop] });
  expect((await call('list_loops', {}, other)).structuredContent).toEqual({ loops: [] });
  const change = {
    loop_id: loop.id,
    version: loop.version,
    action: 'set_interval',
    interval_minutes: 10,
  };
  expect(await call('update_loop', change, other)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'LOOP_NOT_FOUND' } },
  });
  const updated = await call('update_loop', change);
  expect(updated.structuredContent).toMatchObject({
    status: 'acknowledged',
    loop: { intervalMs: 600_000, version: 1 },
  });
  const retryKey = mutationReceipt(updated).request_key;
  expect(await call('update_loop', { ...change, request_key: retryKey })).toEqual(updated);
  expect(
    await call('update_loop', { ...change, interval_minutes: 11, request_key: retryKey }),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'OPERATION_CONFLICT' } },
  });
  expect(service.getOperation(mutationReceipt(updated).operation_id)).toMatchObject({
    kind: 'loop.control.mcp',
  });
  expect(
    await call('update_loop', {
      loop_id: loop.id,
      version: 1,
      action: 'pause',
      interval_minutes: 2,
    }),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'VALIDATION_ERROR' } },
  });

  // A browser cancellation races the session's change at the same optimistic version.
  const [browser, agent] = await Promise.allSettled([
    service.controlSessionLoop(session.threadId, loop.id, {
      clientOperationId: operationId(),
      version: 1,
      action: 'cancel',
    }),
    call('update_loop', { ...change, interval_minutes: 15, version: 1 }),
  ]);
  expect(browser).toMatchObject({
    status: 'fulfilled',
    value: { status: 'acknowledged', result: { status: 'cancelled' } },
  });
  expect(agent).toMatchObject({
    status: 'fulfilled',
    value: { isError: true, structuredContent: { error: { code: 'LOOP_CONFLICT' } } },
  });
  expect(codex.threads.get(session.threadId)?.turns.at(-1)?.status).toBe('running');

  const otherLoop = mutationReceipt(
    await call('create_loop', { prompt: 'Check when appropriate' }),
  ).loop;
  expect(
    (await call('update_loop', { loop_id: otherLoop.id, version: 0, action: 'pause' }))
      .structuredContent,
  ).toMatchObject({ loop: { status: 'paused', nextRunAt: null } });
  const rescheduled = mutationReceipt(
    await call('update_loop', {
      loop_id: otherLoop.id,
      version: 1,
      action: 'set_interval',
      interval_minutes: 30,
    }),
  ).loop;
  expect(rescheduled).toMatchObject({ status: 'paused', intervalMs: null });
  const resumed = mutationReceipt(
    await call('update_loop', {
      loop_id: otherLoop.id,
      version: 2,
      action: 'resume',
    }),
  ).loop;
  expect(resumed).toMatchObject({ status: 'active', nextRunAt: rescheduled.nextRunAt });

  await service.shutdown();
  const restarted = new GatewayService({ store, projects, codex });
  try {
    expect(await restarted.listSessionLoops(session.threadId)).toEqual([
      expect.objectContaining({ id: loop.id, status: 'cancelled', intervalMs: 600_000 }),
      resumed,
    ]);
    expect(restarted.getOperation(mutationReceipt(updated).operation_id)).toMatchObject({
      kind: 'loop.control.mcp',
      status: 'acknowledged',
    } satisfies Partial<Operation>);
  } finally {
    await restarted.shutdown();
  }
});

import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

async function setup() {
  const ctx = harness();
  cleanup.push(ctx.close);
  const mcp = await startManagedMcp({
    service: () => ctx.service,
    publicOrigin: 'http://127.0.0.1:8787',
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

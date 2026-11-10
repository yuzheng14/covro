import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PreviewDiscovery } from '../../src/server/preview/discovery.js';
import { PreviewProxy } from '../../src/server/preview/proxy.js';
import { parseConfig } from '../../src/server/config.js';
import { createAuthenticator } from '../../src/server/auth.js';
import type { CodexClient, CodexEvent } from '../../src/codex/types.js';
import type { ProcessInspector } from '../../src/server/preview/processes.js';
import { generateKeyPair, SignJWT } from 'jose';
import type { Identity } from '../../src/server/auth.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function harness(
  options: { origin?: string; access?: boolean; key?: CryptoKey; identity?: Identity } = {},
) {
  const received: { path: string; method: string; headers: Record<string, unknown> }[] = [];
  const upstream = createServer((req, res) => {
    received.push({ path: req.url!, method: req.method!, headers: req.headers });
    res.setHeader('set-cookie', 'management=must-not-be-set');
    res.setHeader(
      'Content-Type',
      req.url === '/api.js'
        ? 'application/json'
        : req.url === '/events'
          ? 'text/event-stream'
          : 'text/html',
    );
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://unrelated.invalid/' });
      res.end();
    } else res.end(req.url === '/api.js' ? '{"private":"data"}' : '<h1>test project</h1>');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise((r) => {
        upstream.closeAllConnections();
        upstream.close(r);
      }),
  );
  const port = (upstream.address() as { port: number }).port;
  const dataDir = await mkdtemp(join(tmpdir(), 'covro-preview-test-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const origin = options.origin ?? 'http://127.0.0.1:8787';
  const config = parseConfig(
    {
      dataDir,
      publicOrigin: [origin],
      ...(options.access
        ? {
            auth: {
              mode: 'cloudflare-access',
              issuer: 'https://fixture.cloudflareaccess.com',
              audience: 'preview-fixture',
            },
          }
        : {}),
    },
    join(dataDir, 'config.json'),
  );
  const events = new Set<(event: CodexEvent) => void>();
  const codex = {
    epoch: 'fixture-epoch',
    ready: true,
    pid: 100,
    onEvent: (fn: (event: CodexEvent) => void) => {
      events.add(fn);
      return () => {
        events.delete(fn);
      };
    },
  } as CodexClient;
  const inspector: ProcessInspector = {
    snapshot: async () => ({
      processes: new Map([
        [
          201,
          {
            pid: 201,
            parent: 100,
            birth: 'fixture-birth',
            cwd: realpathSync('.'),
            thread: 'session',
            call: 'execution',
          },
        ],
      ]),
      listeners: [{ pid: 201, port, host: '127.0.0.1' }],
    }),
    connected: async () => true,
  };
  const discovery = new PreviewDiscovery(
    codex,
    () => ({
      projectId: 'project',
      projectName: 'Fixture project',
      canonicalCwd: realpathSync('.'),
    }),
    inspector,
  );
  const authenticate = createAuthenticator(config, options.key);
  const proxy = new PreviewProxy(discovery, config, authenticate);
  cleanups.push(async () => proxy.close());
  for (const fn of events)
    fn({
      type: 'previewExecution',
      threadId: 'session',
      itemId: 'execution',
      cwd: realpathSync('.'),
      command: 'fixture-server',
      source: 'agent',
    });
  const run = (await discovery.snapshot('session')).services[0]!;
  const open = async () => {
    await proxy.configure({ enabled: true, fullRequests: false });
    return (await proxy.open(run.id, options.identity ?? {})).url;
  };
  const request = (path: string, init?: RequestInit) =>
    proxy.handle(new Request(`http://${new URL(origin).host}${path}`, init));
  return { proxy, discovery, authenticate, inspector, received, open, request, run, dataDir };
}

it('defaults closed, requires a server grant, filters each resource response, and rejects writes before forwarding', async () => {
  const h = await harness();
  await h.proxy.load();
  expect(h.proxy.configuration()).toEqual({ enabled: false, fullRequests: false });
  await expect(h.proxy.open(h.run.id, {})).rejects.toMatchObject({ code: 'PREVIEW_DISABLED' });
  const path = await h.open();
  expect(await (await h.request(path)).text()).toContain('test project');
  await expect(h.request(path + 'api.js')).rejects.toMatchObject({ code: 'PREVIEW_TYPE' });
  await expect(h.request(path + 'events')).rejects.toMatchObject({ code: 'PREVIEW_TYPE' });
  const count = h.received.length;
  await expect(h.request(path + 'write', { method: 'POST' })).rejects.toMatchObject({
    code: 'PREVIEW_METHOD',
  });
  await expect(
    h.request(path + 'read', { headers: { 'sec-fetch-dest': 'empty' } }),
  ).rejects.toMatchObject({ code: 'PREVIEW_REQUEST' });
  expect(h.received).toHaveLength(count);
  await expect(h.request('/preview/unknown/')).rejects.toMatchObject({ status: 410 });
});

it('isolates every response and strips all management and Access credentials in both directions', async () => {
  const h = await harness();
  const path = await h.open();
  const response = await h.request(path, {
    headers: {
      origin: 'null',
      cookie: 'management=secret; CF_Authorization=secret',
      authorization: 'Bearer secret',
      'cf-access-jwt-assertion': 'secret',
      'cf-access-client-secret': 'secret',
      'x-forwarded-host': 'management',
    },
  });
  await response.text();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  expect(h.received[0]!.headers).not.toHaveProperty('cookie');
  expect(JSON.stringify(h.received[0]!.headers)).not.toContain('secret');
  await expect(
    h.authenticate(
      new Request('http://127.0.0.1:8787/api/config', { headers: { origin: 'null' } }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
  await expect(
    h.request(path, { headers: { origin: 'https://external.invalid' } }),
  ).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
  await expect(h.request(path + 'redirect')).rejects.toMatchObject({ code: 'PREVIEW_REDIRECT' });
});

it('does not send HTTP to an accepted socket whose owner cannot be proved', async () => {
  const h = await harness();
  const path = await h.open();
  h.inspector.connected = async () => false;
  await expect(h.request(path)).rejects.toMatchObject({ code: 'PREVIEW_OWNER' });
  expect(h.received).toEqual([]);
});

it('full requests remain run-bound and disabling either switch revokes existing grants immediately', async () => {
  const h = await harness();
  await h.open();
  await h.proxy.configure({ enabled: true, fullRequests: true });
  const path = (await h.proxy.open(h.run.id, {})).url;
  const result = await h.request(path + 'api.js', { method: 'POST', body: 'write' });
  expect(await result.json()).toEqual({ private: 'data' });
  await h.proxy.configure({ enabled: true, fullRequests: false });
  await expect(h.request(path)).rejects.toMatchObject({ status: 410 });
  await h.proxy.configure({ enabled: false, fullRequests: true });
  expect(h.proxy.configuration()).toEqual({ enabled: false, fullRequests: false });
  await expect(h.proxy.open(h.run.id, {})).rejects.toMatchObject({ code: 'PREVIEW_DISABLED' });
});

it('relays explicit application requests without preflights or inherited credentials and rejects a different run target', async () => {
  const h = await harness();
  await h.open();
  await h.proxy.configure({ enabled: true, fullRequests: true });
  const path = (await h.proxy.open(h.run.id, {})).url;
  const relay = (url: string) =>
    h.request(path + '__covro_request', {
      method: 'POST',
      headers: {
        origin: 'null',
        'content-type': 'text/plain',
        cookie: 'management=secret',
        authorization: 'Bearer management-secret',
      },
      body: JSON.stringify({
        url,
        method: 'POST',
        headers: {
          authorization: 'Bearer application-fixture',
          'cf-access-jwt-assertion': 'secret',
          'content-type': 'application/json',
        },
        body: Buffer.from('{"value":1}').toString('base64'),
      }),
    });
  const response = await relay('http://127.0.0.1:8787' + path + 'api.js');
  expect(await response.json()).toEqual({ private: 'data' });
  expect(h.received.at(-1)!.method).toBe('POST');
  expect(h.received.at(-1)!.headers['content-type']).toBe('application/json');
  expect(JSON.stringify(h.received.at(-1)!.headers)).not.toContain('secret');
  expect(h.received.at(-1)!.headers.authorization).toBe('Bearer application-fixture');
  await expect(relay('http://127.0.0.1:5173/')).rejects.toMatchObject({ code: 'PREVIEW_RELAY' });
  const other = (await h.proxy.open(h.run.id, {})).url;
  await expect(relay('http://127.0.0.1:8787' + other)).rejects.toMatchObject({
    code: 'PREVIEW_RELAY',
  });
});

it('binds opaque-origin resources to a verified Access subject and the authenticated HTTPS entry behind TLS termination', async () => {
  const keys = await generateKeyPair('RS256');
  const token = (subject: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://fixture.cloudflareaccess.com')
      .setAudience('preview-fixture')
      .setSubject(subject)
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  const alice = await token('alice');
  const bob = await token('bob');
  const h = await harness({
    origin: 'https://preview.example',
    access: true,
    key: keys.publicKey,
    identity: { subject: 'alice', expiresAt: Date.now() + 300_000 },
  });
  const path = await h.open();
  await expect(h.request(path, { headers: { origin: 'null' } })).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
  });
  await expect(
    h.request(path, { headers: { origin: 'null', 'cf-access-jwt-assertion': bob } }),
  ).rejects.toMatchObject({ code: 'PREVIEW_IDENTITY' });
  const response = await h.request(path, {
    headers: {
      origin: 'null',
      'cf-access-jwt-assertion': alice,
      'x-forwarded-host': 'unrelated.invalid',
      'x-forwarded-proto': 'http',
      cookie: 'CF_Authorization=management-fixture',
      authorization: 'Bearer management-fixture',
    },
  });
  expect(await response.text()).toContain('test project');
  expect(response.headers.get('content-security-policy')).toContain(
    'https://preview.example' + path,
  );
  expect(response.headers.get('content-security-policy')).toContain('wss://preview.example' + path);
  expect(response.headers.get('access-control-allow-origin')).toBe('null');
  expect(JSON.stringify(h.received.at(-1)!.headers)).not.toContain(alice);
  expect(JSON.stringify(h.received.at(-1)!.headers)).not.toContain('management-fixture');
  await expect(
    h.authenticate(
      new Request('http://preview.example/api/config', {
        headers: { origin: 'null', 'cf-access-jwt-assertion': alice },
      }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
});

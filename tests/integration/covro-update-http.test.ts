import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { assessCodexCompatibility } from '../../src/shared/codex-compatibility.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import type { UpdateController, UpdateStatus } from '../../src/shared/updates.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function fixture() {
  const h = harness();
  cleanups.push(h.close);
  const status: UpdateStatus = {
    version: '0.1.0',
    source: 'npm',
    codex: assessCodexCompatibility(CODEX_COMPATIBILITY, CODEX_COMPATIBILITY.recommended),
    supported: true,
    settings: { channel: 'stable', automatic: false },
  };
  const updates: UpdateController = {
    status: async () => status,
    check: vi.fn(async () => status),
    configure: vi.fn(async () => status),
    start: vi.fn(async () => status),
    cancel: vi.fn(async () => status),
    close: () => {},
  };
  const origin = 'http://127.0.0.1:8787';
  const app = createApp({
    config: parseConfig({}, '/tmp/config.json'),
    service: h.service,
    staticDir: h.directory,
    updates,
  });
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    app.request(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { h, app, updates, post, origin };
}
it('protects update controls with the existing origin rules and rejects arbitrary package selectors', async () => {
  const { post, updates } = fixture();
  const input = { clientOperationId: randomUUID(), channel: 'dev' };
  expect(
    (await post('/api/updates/run', input, { origin: 'https://attacker.example' })).status,
  ).toBe(403);
  expect((await post('/api/updates/run', { ...input, package: 'other-package' })).status).toBe(400);
  expect(
    (await post('/api/updates/run', { ...input, channel: 'https://attacker.example' })).status,
  ).toBe(400);
  expect(updates.start).not.toHaveBeenCalled();
  expect((await post('/api/updates/run', input)).status).toBe(202);
  expect(updates.start).toHaveBeenCalledExactlyOnceWith(input);
});
it('keeps status available while fencing project and task mutations during activation', async () => {
  const { post, app, h, origin } = fixture();
  expect(h.service.prepareUpdate().ready).toBe(true);
  expect((await post('/api/projects', { path: h.directory })).status).toBe(503);
  expect(
    (await post('/api/projects/project/threads', { clientOperationId: randomUUID() })).status,
  ).toBe(503);
  const response = await app.request(origin + '/api/updates');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it('validates release-note selectors and keeps update controls independent of GitHub failures', async () => {
  const { app, origin, post, updates } = fixture();
  const fetcher = vi.fn(async () => Response.json({}, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  for (const query of ['', '?version=latest', '?version=../latest', '?version=0.4.0&refresh=bad'])
    expect((await app.request(`${origin}/api/updates/release-notes${query}`)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await app.request(`${origin}/api/updates/release-notes?version=0.4.0`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    version: '0.4.0',
    state: 'error',
    reason: 'rateLimited',
  });
  expect((await app.request(`${origin}/api/updates`)).status).toBe(200);
  expect(
    (await post('/api/updates/run', { clientOperationId: randomUUID(), channel: 'stable' })).status,
  ).toBe(202);
  expect(updates.start).toHaveBeenCalledTimes(1);
});

it('validates cancellation identities and retains the normal origin boundary', async () => {
  const { post, updates } = fixture();
  const id = randomUUID();
  expect(
    (await post('/api/updates/cancel', { id }, { origin: 'https://attacker.example' })).status,
  ).toBe(403);
  expect((await post('/api/updates/cancel', { id: '../run' })).status).toBe(400);
  expect(updates.cancel).not.toHaveBeenCalled();
  expect((await post('/api/updates/cancel', { id })).status).toBe(200);
  expect(updates.cancel).toHaveBeenCalledExactlyOnceWith(id);
});

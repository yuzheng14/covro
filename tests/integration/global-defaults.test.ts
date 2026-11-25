import { join } from 'node:path';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexError } from '../../src/codex/transport.js';
import type {
  GlobalDefaultsSnapshot,
  SaveGlobalDefaultsInput,
} from '../../src/shared/global-defaults.js';
import { captureLogger } from '../fixtures/logging.js';
import { deferred, harness } from './domain-helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const logs = captureLogger();
  const h = harness(logs.logger);
  cleanup.push(h.close);
  let snapshot: GlobalDefaultsSnapshot = {
    settings: { model: null, reasoningEffort: null, permissionMode: 'read-only' },
    models: [],
    capabilities: {
      autoReview: false,
      allowedSandboxModes: null,
      allowedApprovalPolicies: null,
      allowedReviewers: null,
      allowedProfiles: null,
      autoReviewRequiredModels: [],
    },
    version: 'initial',
  };
  const read = vi.fn(async () => structuredClone(snapshot));
  const write = vi.fn(async (input: SaveGlobalDefaultsInput) => {
    snapshot = { ...snapshot, settings: input.settings, version: 'saved' };
    return { status: 'ok' as const };
  });
  Object.assign(h.codex, { readGlobalDefaults: read, saveGlobalDefaults: write });
  const input: SaveGlobalDefaultsInput = {
    version: 'initial',
    settings: {
      model: 'private-model-setting',
      reasoningEffort: 'high',
      permissionMode: 'read-only',
    },
  };
  return { ...h, ...logs, read, write, input };
}

it('does not leave an unknown operation after a committed write loses its acknowledgement and configuration is reread or reconnected', async () => {
  const h = fixture();
  const apply = h.write.getMockImplementation()!;
  h.write.mockImplementation(async (input) => {
    await apply(input);
    throw new CodexError('RPC_TIMEOUT', 'private configuration details', true);
  });
  await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
    code: 'RPC_TIMEOUT',
    uncertain: true,
  });
  expect((await h.service.readGlobalDefaults()).settings).toEqual(h.input.settings);
  expect(h.store.unresolvedOperations()).toEqual([]);
  expect(
    h.db.database.$client.prepare('SELECT count(*) AS count FROM operations').get(),
  ).toMatchObject({
    count: 0,
  });
  h.codex.reset();
  expect((await h.service.readGlobalDefaults()).version).toBe('saved');
  for (const reason of ['backup', 'update'] as const)
    expect(h.service.prepareUpdate(reason, false)).toEqual({ ready: true });
  expect(h.service.restartBlockers()).toEqual([]);
  expect(h.write).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.records)).not.toContain('private-model-setting');
  expect(JSON.stringify(h.records)).not.toContain('private configuration details');
  expect(
    h.records.some(
      (row) => row.event === 'global_defaults.save_failed' && row.errorCode === 'RPC_TIMEOUT',
    ),
  ).toBe(true);
});
it('saves directly with the supplied version and returns native status without creating a receipt', async () => {
  const h = fixture();
  await expect(h.service.saveGlobalDefaults(h.input)).resolves.toEqual({ status: 'ok' });
  expect(h.write).toHaveBeenCalledWith(h.input);
  expect((await h.service.readGlobalDefaults()).settings).toEqual(h.input.settings);
  expect(h.store.unresolvedOperations()).toEqual([]);
  expect(
    h.db.database.$client.prepare('SELECT count(*) AS count FROM operations').get(),
  ).toMatchObject({
    count: 0,
  });
  expect(h.records.some((row) => row.event === 'global_defaults.saved')).toBe(true);
});
it('holds maintenance only while the configuration write is pending and lets shutdown await its settlement', async () => {
  const h = fixture();
  const gate = deferred<{ status: 'ok' }>();
  h.write.mockImplementation(() => gate.promise);
  const saving = h.service.saveGlobalDefaults(h.input);
  expect(h.service.prepareUpdate('backup', false).ready).toBe(false);
  expect(h.service.restartBlockers()).toContain('operation');
  expect(h.store.unresolvedOperations()).toEqual([]);
  const stopping = h.service.shutdown();
  expect(h.codex.stops).toBe(0);
  gate.resolve({ status: 'ok' });
  await saving;
  await stopping;
  expect(h.codex.stops).toBe(1);
  expect(h.service.prepareUpdate('backup', false)).toEqual({ ready: true });
  await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
    code: 'CODEX_UNAVAILABLE',
  });
  expect(h.write).toHaveBeenCalledTimes(1);
});
it('retains the write gate until every concurrent request settles, including an uncertain failure', async () => {
  const h = fixture();
  const first = deferred<{ status: 'ok' }>(),
    second = deferred<{ status: 'ok' }>();
  h.write.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const a = h.service.saveGlobalDefaults(h.input),
    b = h.service.saveGlobalDefaults(h.input);
  const rejected = expect(a).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
  first.reject(new CodexError('RPC_TIMEOUT', 'not confirmed', true));
  await rejected;
  expect(h.service.prepareUpdate('update', false).ready).toBe(false);
  second.resolve({ status: 'ok' });
  await b;
  expect(h.service.prepareUpdate('update', false)).toEqual({ ready: true });
  expect(h.store.unresolvedOperations()).toEqual([]);
});

describe('configuration write admission', () => {
  it('rejects maintenance, unavailable runtime, missing support and unconfirmed compatibility before writing', async () => {
    const h = fixture();
    h.service.setMaintenance(true, 'backup');
    await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
      code: 'BACKUP_MAINTENANCE',
    });
    h.service.setMaintenance(false, 'backup');
    h.codex.ready = false;
    await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
      code: 'CODEX_UNAVAILABLE',
    });
    h.codex.ready = true;
    h.codex.compatibility = 'unverified';
    await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
      code: 'COMPATIBILITY_CONFIRMATION_REQUIRED',
    });
    h.codex.compatibility = 'verified';
    Object.assign(h.codex, { saveGlobalDefaults: undefined });
    await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
    });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.store.unresolvedOperations()).toEqual([]);
  });
  it('preserves definite version conflicts without turning them into persistent unknown operations', async () => {
    const h = fixture();
    h.write.mockRejectedValue(new CodexError('RPC_ERROR', 'Version changed', false));
    await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
      code: 'RPC_ERROR',
      uncertain: false,
    });
    expect((await h.service.readGlobalDefaults()).version).toBe('initial');
    expect(h.service.prepareUpdate('backup', false)).toEqual({ ready: true });
    expect(h.store.unresolvedOperations()).toEqual([]);
  });
});

it('returns native configuration status through the guarded HTTP route without operation receipts', async () => {
  const h = fixture();
  const config = parseConfig(
    { dataDir: join(h.directory, 'data') },
    join(h.directory, 'config.json'),
  );
  const app = createApp({ config, service: h.service, staticDir: '/unused' });
  const post = (body: unknown, origin = 'http://127.0.0.1:8787') =>
    app.request('http://127.0.0.1:8787/api/settings/defaults', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post(h.input, 'https://foreign.example')).status).toBe(403);
  expect(h.write).not.toHaveBeenCalled();
  const response = await post(h.input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
  expect((await post({ ...h.input, clientOperationId: crypto.randomUUID() })).status).toBe(400);
  const apply = h.write.getMockImplementation()!;
  h.write.mockImplementation(async (input) => {
    await apply(input);
    throw new CodexError('RPC_TIMEOUT', 'Fixture acknowledgement lost', true);
  });
  const lost = await post({ ...h.input, version: 'saved' });
  expect(lost.status).toBe(503);
  expect(await lost.json()).toMatchObject({
    error: { code: 'RPC_TIMEOUT', details: { uncertain: true } },
  });
  const latest = await app.request('http://127.0.0.1:8787/api/settings/defaults');
  expect((await latest.json()).settings).toEqual(h.input.settings);
  for (const reason of ['backup', 'update'] as const)
    expect(h.service.prepareUpdate(reason, false)).toEqual({ ready: true });
  expect(
    h.db.database.$client.prepare('SELECT count(*) AS count FROM operations').get(),
  ).toMatchObject({ count: 0 });
});

it('rejects an invalid native write result without reporting success or leaving maintenance blocked', async () => {
  const h = fixture();
  Object.assign(h.codex, {
    saveGlobalDefaults: async () => ({ status: 'private-unexpected-payload' }),
  });
  await expect(h.service.saveGlobalDefaults(h.input)).rejects.toMatchObject({
    code: 'PROTOCOL_INCOMPATIBLE',
  });
  expect(h.records.some((row) => row.event === 'global_defaults.saved')).toBe(false);
  expect(JSON.stringify(h.records)).not.toContain('private-unexpected-payload');
  expect(h.store.unresolvedOperations()).toEqual([]);
  expect(h.service.prepareUpdate('backup', false)).toEqual({ ready: true });
});

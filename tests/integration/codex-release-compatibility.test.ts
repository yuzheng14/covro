import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import {
  assessCodexCompatibility,
  codexCompatibilitySchema,
  requireCodexCompatibility,
} from '../../src/shared/codex-compatibility.js';
import { UpdateManager } from '../../src/updates/manager.js';
import * as registry from '../../src/updates/registry.js';
import * as runtime from '../../src/updates/runtime.js';
import { runningRuntime } from '../../src/cli/runtime.js';
import { paths, packageInfo } from '../../src/cli/paths.js';
import { releaseCompatibilityNotes } from '../../scripts/release-compatibility.js';
import * as updateFiles from '../../src/updates/files.js';
import { saveJson } from '../../src/updates/files.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.restoreAllMocks();
});
const manifest = {
  recommended: '0.164.0',
  verified: ['0.164.0'],
  unsupported: [{ version: '0.162.0', reason: 'Removed protocol method' }],
};
it('requires explicit exact versions and rejects contradictory or incomplete release declarations', () => {
  for (const value of [
    undefined,
    {},
    { ...manifest, verified: ['^0.164.0'] },
    { ...manifest, recommended: '0.165.0' },
    { ...manifest, verified: ['0.164.0', '0.162.0'] },
  ])
    expect(codexCompatibilitySchema.safeParse(value).success).toBe(false);
  expect(assessCodexCompatibility(manifest, '0.164.0').status).toBe('verified');
  expect(assessCodexCompatibility(manifest, '0.163.0').status).toBe('unverified');
  expect(assessCodexCompatibility(manifest, '0.162.0').status).toBe('unsupported');
  expect(assessCodexCompatibility(manifest, null).status).toBe('unknown');
  expect(() => requireCodexCompatibility(manifest, '0.162.0', true)).toThrow('不支持');
  expect(() => requireCodexCompatibility(undefined, '0.163.0', true)).toThrow('兼容声明');
  expect(() => requireCodexCompatibility(manifest, null, true)).toThrow('无法确认');
  expect(requireCodexCompatibility(manifest, '0.163.0', true).status).toBe('unverified');
});

async function managerFixture(metadata: unknown = manifest) {
  const directory = await mkdtemp(join(tmpdir(), 'covro-codex-gate-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.spyOn(registry, 'inspectInstallation').mockResolvedValue(undefined);
  vi.spyOn(runtime, 'resolveRuntimeTarget').mockResolvedValue({
    ...runningRuntime(),
    npm: '/npm/bin/npm-cli.js',
    npmVersion: '11.0.0',
    prefix: '/npm',
    globalRoot: '/npm/lib/node_modules',
    path: process.env.PATH!,
    version: packageInfo.version,
  });
  vi.spyOn(registry, 'lookupRelease').mockResolvedValue({
    name: '@covro/covro',
    channel: 'stable',
    version: '9.0.0',
    covroCodex: metadata,
  });
  let version: string | null = '0.163.0';
  const manager = new UpdateManager(
    { ...paths(join(directory, 'config.json')), home: directory, state: join(directory, 'state') },
    directory,
    () => version,
  );
  cleanup.push(() => manager.close());
  await manager.initialize();
  // Drain the startup check before asserting later explicit checks/automatic ticks.
  await vi.waitFor(() => expect(registry.lookupRelease).toHaveBeenCalled());
  await manager.check();
  return {
    manager,
    setVersion: (next: string | null) => {
      version = next;
    },
  };
}
it('reassesses the live configured Codex and rejects stale manual confirmations before creating an upgrade run', async () => {
  const { manager, setVersion } = await managerFixture();
  expect((await manager.check()).available?.codex.status).toBe('unverified');
  await expect(manager.start({ clientOperationId: crypto.randomUUID() })).rejects.toMatchObject({
    code: 'UPDATE_CODEX_INCOMPATIBLE',
  });
  await expect(
    manager.start({
      clientOperationId: crypto.randomUUID(),
      codexConfirmation: { version: '0.163.0', target: '8.0.0' },
    }),
  ).rejects.toMatchObject({ code: 'UPDATE_CODEX_CHANGED' });
  setVersion('0.164.0');
  expect((await manager.status()).available?.codex.status).toBe('verified');
  await expect(
    manager.start({
      clientOperationId: crypto.randomUUID(),
      codexConfirmation: { version: '0.163.0', target: '9.0.0' },
    }),
  ).rejects.toMatchObject({ code: 'UPDATE_CODEX_CHANGED' });
  expect((await manager.status()).run).toBeUndefined();
});
it('keeps automatic installation paused for unverified, unsupported, unavailable or missing metadata on every channel', async () => {
  vi.useFakeTimers();
  cleanup.push(() => vi.useRealTimers());
  vi.spyOn(updateFiles, 'readJson').mockResolvedValue(undefined);
  const { manager, setVersion } = await managerFixture();
  const start = vi.spyOn(manager, 'start').mockImplementation(async () => manager.status());
  await vi.advanceTimersByTimeAsync(0);
  for (const channel of ['stable', 'beta', 'dev'] as const) {
    await manager.configure({ channel, automatic: true });
    for (const version of ['0.163.0', '0.162.0', null]) {
      setVersion(version);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(start).not.toHaveBeenCalled();
    }
    vi.mocked(registry.lookupRelease).mockResolvedValue({
      name: '@covro/covro',
      channel: 'stable',
      version: '9.0.0',
    });
    setVersion('0.164.0');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(start).not.toHaveBeenCalled();
    vi.mocked(registry.lookupRelease).mockResolvedValue({
      name: '@covro/covro',
      channel: 'stable',
      version: '9.0.0',
      covroCodex: manifest,
    });
  }
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]?.[0].codexConfirmation).toBeUndefined();
});
it('refuses activation when the running Codex changed, then commits only after its exact version matches', async () => {
  const { manager, setVersion } = await managerFixture();
  const id = crypto.randomUUID();
  await saveJson(join(manager.context!.directory, 'run.json'), {
    id,
    from: '0.0.0',
    target: packageInfo.version,
    channel: 'dev',
    phase: 'verifying',
    codex: {
      version: CODEX_COMPATIBILITY.recommended,
      manifest: CODEX_COMPATIBILITY,
      confirmedUnverified: false,
    },
  });
  setVersion('99.0.0');
  await expect(manager.commitActivation(id)).rejects.toThrow('发生变化');
  setVersion(CODEX_COMPATIBILITY.recommended);
  await manager.commitActivation(id);
  expect((await manager.status()).run?.committed).toBe(true);
});
it('renders Release compatibility from immutable package metadata and replaces its own block idempotently', () => {
  const once = releaseCompatibilityNotes('## Features\n- Existing release notes', manifest);
  expect(once).toContain('**0.164.0**');
  expect(once).toContain('Removed protocol method');
  expect(releaseCompatibilityNotes(once, CODEX_COMPATIBILITY)).toContain(
    `**${CODEX_COMPATIBILITY.recommended}**`,
  );
  expect(releaseCompatibilityNotes(once, manifest)).toBe(once);
  expect(() => releaseCompatibilityNotes('body', undefined)).toThrow();
});

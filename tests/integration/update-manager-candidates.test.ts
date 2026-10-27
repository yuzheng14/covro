import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import lockfile from 'proper-lockfile';
import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { paths, packageInfo } from '../../src/cli/paths.js';
import { UpdateManager } from '../../src/updates/manager.js';
import * as registry from '../../src/updates/registry.js';
import * as runtime from '../../src/updates/runtime.js';
import { runningRuntime } from '../../src/cli/runtime.js';
import { readJson, saveJson } from '../../src/updates/files.js';
import type { ReleaseChannel, UpdateRun, UpdateSettings } from '../../src/shared/updates.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  copyFile: vi.fn(),
}));

const cleanup: (() => unknown)[] = [];
const originalVersion = packageInfo.version;
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  packageInfo.version = originalVersion;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(channel: ReleaseChannel, version = '0.2.0', automatic = false) {
  const directory = await mkdtemp(join(tmpdir(), 'covro-candidates-'));
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
  let tags: Record<string, string | number> = {
    latest: version,
    beta: '0.2.0-beta.1',
    dev: '0.1.1-dev.8',
  };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const tag = String(url).split('/').at(-1)!;
    const version = tags[tag] ?? 404;
    return typeof version === 'number'
      ? new Response('', { status: version })
      : new Response(
          JSON.stringify({
            name: '@covro/covro',
            version,
            covroCommit: `commit-${version}`,
            covroCodex: CODEX_COMPATIBILITY,
          }),
        );
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ReturnType<typeof spawn>;
  });
  const location = {
    ...paths(join(directory, 'config.json')),
    home: directory,
    state: join(directory, 'state'),
  };
  const manager = new UpdateManager(location, directory, () => CODEX_COMPATIBILITY.recommended);
  cleanup.push(() => manager.close());
  await saveJson(join(manager.context!.directory, 'settings.json'), { channel, automatic });
  await manager.initialize();
  await vi.waitFor(async () => expect((await manager.status()).checkedAt).toBeDefined());
  // Startup checks are asynchronous; let the automatic handler finish before later assertions.
  await vi.waitFor(async () =>
    expect((await manager.status()).run?.phase ?? 'idle').toBe(automatic ? 'installing' : 'idle'),
  );
  if (automatic)
    await vi.waitFor(async () =>
      expect(await lockfile.check(manager.context!.directory)).toBe(false),
    );
  return {
    manager,
    fetch,
    location,
    directory,
    setTags: (next: typeof tags) => {
      tags = next;
    },
  };
}

it.each(['beta', 'dev'] as const)(
  '%s installs stable and preserves its subscription through activation and restart',
  async (channel) => {
    packageInfo.version = `0.2.0-${channel}.1`;
    const { manager, location, directory, setTags } = await fixture(channel);
    const checked = await manager.check();
    expect(checked).toMatchObject({
      settings: { channel },
      available: {
        version: '0.2.0',
        channel: 'stable',
        requestedChannel: channel,
        commit: 'commit-0.2.0',
        downgrade: false,
      },
    });
    const id = crypto.randomUUID();
    const started = await manager.start({ clientOperationId: id });
    expect(started.run).toMatchObject({
      target: '0.2.0',
      channel,
      sourceChannel: 'stable',
      commit: 'commit-0.2.0',
    });
    expect(spawn).toHaveBeenCalledOnce();
    await saveJson(join(manager.context!.directory, 'run.json'), {
      ...started.run,
      phase: 'verifying',
    });
    packageInfo.version = '0.2.0';
    manager.close();
    const restarted = new UpdateManager(location, directory, () => CODEX_COMPATIBILITY.recommended);
    cleanup.push(() => restarted.close());
    await restarted.initialize();
    await restarted.commitActivation(id);
    expect((await restarted.status()).settings.channel).toBe(channel);
    expect(
      await readJson<UpdateSettings>(join(restarted.context!.directory, 'settings.json')),
    ).toMatchObject({ channel });
    expect((await restarted.check()).available).toMatchObject({
      version: '0.2.0',
      downgrade: false,
    });
    expect((await restarted.start({ clientOperationId: crypto.randomUUID() })).run?.id).toBe(id);
    expect(spawn).toHaveBeenCalledOnce();
    setTags({ latest: '0.2.0', [channel]: `0.3.0-${channel}.1` });
    expect((await restarted.check()).available).toMatchObject({
      version: `0.3.0-${channel}.1`,
      channel,
      requestedChannel: channel,
    });
  },
);

it.each(['beta', 'dev'] as const)(
  '%s automatic startup uses the same stable selection and subscription',
  async (channel) => {
    packageInfo.version = `0.2.0-${channel}.1`;
    const { manager } = await fixture(channel, '0.2.0', true);
    expect((await manager.status()).run).toMatchObject({
      target: '0.2.0',
      channel,
      sourceChannel: 'stable',
    });
  },
);

it('uses the explicit requested subscription for a CLI or HTTP channel switch', async () => {
  packageInfo.version = '0.1.0';
  const { manager } = await fixture('stable');
  expect(
    (await manager.start({ clientOperationId: crypto.randomUUID(), channel: 'dev' })).run,
  ).toMatchObject({ channel: 'dev', sourceChannel: 'stable', target: '0.2.0' });
});

it.each(['beta', 'dev'] as const)(
  '%s never automatically downgrades or repeats an equal SemVer version',
  async (channel) => {
    vi.useFakeTimers();
    packageInfo.version = `0.3.0-${channel}.1`;
    const { manager, setTags } = await fixture(channel);
    await manager.configure({ channel, automatic: true });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect((await manager.status()).available?.downgrade).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    await expect(manager.start({ clientOperationId: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'UPDATE_DOWNGRADE',
    });
    setTags({ latest: packageInfo.version + '+same', [channel]: 404 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await manager.start({ clientOperationId: crypto.randomUUID() });
    expect(spawn).not.toHaveBeenCalled();
    setTags({ latest: '0.2.0', [channel]: 404 });
    expect(
      (await manager.start({ clientOperationId: crypto.randomUUID(), allowDowngrade: true })).run,
    ).toMatchObject({ target: '0.2.0', channel, sourceChannel: 'stable' });
  },
);

it('clears a stale candidate and blocks installation after a partial registry failure', async () => {
  packageInfo.version = '0.1.0';
  const { manager, setTags } = await fixture('dev');
  expect((await manager.check()).available).toBeDefined();
  setTags({ latest: '0.2.0', dev: 503 });
  expect(await manager.check()).toMatchObject({
    available: undefined,
    checkError: expect.stringContaining('503'),
  });
  await expect(manager.start({ clientOperationId: crypto.randomUUID() })).rejects.toMatchObject({
    code: 'UPDATE_CHECK_FAILED',
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(await readJson<UpdateRun>(join(manager.context!.directory, 'run.json'))).toBeUndefined();
});

it('migrates an equal version while retaining Codex activation checks and the durable update directory', async () => {
  packageInfo.version = '0.2.0';
  const { manager, location, directory } = await fixture('stable');
  const target = {
    ...(await runtime.resolveRuntimeTarget()),
    node: '/new/node',
    nodeVersion: '24.22.1',
    root: '/new/lib/node_modules/@covro/covro',
    entry: '/new/lib/node_modules/@covro/covro/bin/covro.mjs',
    covroCodex: CODEX_COMPATIBILITY,
  };
  vi.mocked(runtime.resolveRuntimeTarget).mockResolvedValue(target);
  const started = await manager.start({ clientOperationId: crypto.randomUUID() });
  expect(started.run).toMatchObject({ from: '0.2.0', target: '0.2.0', runtime: { target } });
  expect(spawn).toHaveBeenCalledOnce();
  expect(await readJson(join(location.state, 'updates.json'))).toEqual({
    directory: manager.context!.directory,
  });
  expect(await readJson(join(manager.context!.directory, 'context.json'))).toMatchObject({
    reuseTarget: true,
    target,
  });
  await saveJson(join(manager.context!.directory, 'run.json'), {
    ...started.run,
    phase: 'verifying',
  });
  // Matching Covro versions alone cannot authorize an old Node process to commit the new runtime.
  await expect(manager.commitActivation(started.run!.id)).rejects.toThrow('Node');
  const restarted = new UpdateManager(location, directory, () => CODEX_COMPATIBILITY.recommended);
  cleanup.push(() => restarted.close());
  await restarted.initialize();
  expect(restarted.context!.directory).toBe(manager.context!.directory);
});

it('selects a newer preinstalled target without silently downgrading it to the channel tag', async () => {
  packageInfo.version = '0.3.0';
  const { manager } = await fixture('stable', '0.2.0');
  const target = {
    ...(await runtime.resolveRuntimeTarget()),
    node: '/new/node',
    version: '0.4.0',
    covroCodex: CODEX_COMPATIBILITY,
  };
  vi.mocked(runtime.resolveRuntimeTarget).mockResolvedValue(target);
  expect((await manager.check()).available).toMatchObject({ version: '0.4.0', downgrade: false });
  expect((await manager.start({ clientOperationId: crypto.randomUUID() })).run?.target).toBe(
    '0.4.0',
  );
});

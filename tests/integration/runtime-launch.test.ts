import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ home: '', exec: vi.fn() }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => io.home,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }),
}));
import {
  launchRuntime,
  snapshotLaunch,
  switchLaunch,
  restoreLaunch,
  systemdQuote,
} from '../../src/cli/runtime-launch.js';
import { launchdPlist } from '../../src/cli/launchd.js';
import { paths } from '../../src/cli/paths.js';
import { saveJson } from '../../src/updates/files.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => {
  io.home = await mkdtemp('/tmp/c281-service-');
  io.exec.mockReset();
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  await rm(io.home, { recursive: true, force: true });
});
for (const system of ['darwin', 'linux']) {
  it(`${system}: persists the target Node and entry, preserves service settings, and restores exact startup bytes`, async () => {
    Object.defineProperty(process, 'platform', { value: system });
    const location = {
      ...paths(join(io.home, 'config.json')),
      home: io.home,
      state: join(io.home, 'state'),
    };
    const old = { node: '/old/node', entry: '/old/covro.mjs', path: '/old/bin:/usr/bin' };
    const target = {
      node: '/new path/$node',
      entry: '/new path/covro.mjs',
      path: '/new path/bin:/usr/bin',
    };
    const label = `dev.covro.${location.key}`;
    const filename =
      system === 'darwin'
        ? join(io.home, 'Library/LaunchAgents', `${label}.plist`)
        : join(io.home, '.config/systemd/user', `${label}.service`);
    const content =
      system === 'darwin'
        ? launchdPlist(
            location,
            [old.node, old.entry, 'run', '--config', location.config],
            true,
            old.path,
          )
        : `[Service]\nExecStart=${[old.node, old.entry, 'run', '--config', location.config].map(systemdQuote).join(' ')}\nEnvironment="PATH=${old.path}" "KEEP=setting"\nRestart=on-failure\n`;
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, content);
    await saveJson(join(location.state, 'service.json'), { platform: system, label });
    io.exec.mockResolvedValue({ stdout: `FragmentPath=${filename}\nDropInPaths=\n` });
    const snapshot = await snapshotLaunch(location, old);
    await switchLaunch(location, target, snapshot);
    const updated = await readFile(filename, 'utf8');
    expect(updated).toContain(system === 'darwin' ? '/new path/$node' : '/new path/$$node');
    expect(updated).toContain(system === 'darwin' ? 'KeepAlive' : 'KEEP=setting');
    expect(await launchRuntime(location, '/ignored-old-entry')).toEqual(target);
    await restoreLaunch(location, snapshot);
    expect(await readFile(filename, 'utf8')).toBe(content);
    expect((await launchRuntime(location, old.entry)).entry).toBe(old.entry);
    if (system === 'linux')
      expect(io.exec).toHaveBeenCalledWith(
        'systemctl',
        ['--user', 'daemon-reload'],
        expect.anything(),
      );
    // Startup source mismatches must be diagnosed before any write.
    await writeFile(filename, content.replace('/old/node', '/unexpected/node'));
    await expect(snapshotLaunch(location, old)).rejects.toThrow('启动来源');
    await expect(switchLaunch(location, target, snapshot)).rejects.toThrow('升级期间被修改');
    await expect(restoreLaunch(location, snapshot)).rejects.toThrow('外部修改');
    expect(await readFile(filename, 'utf8')).toContain('/unexpected/node');
  });
}
it('refuses unrecognized external process managers before modifying launch state', async () => {
  vi.stubEnv('PM2_HOME', '/external');
  const location = {
    ...paths(join(io.home, 'config.json')),
    home: io.home,
    state: join(io.home, 'state'),
  };
  await expect(
    snapshotLaunch(location, { node: '/node', entry: '/covro', path: '/bin' }),
  ).rejects.toThrow('外部进程管理器');
});

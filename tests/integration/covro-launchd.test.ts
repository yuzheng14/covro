import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  exec: vi.fn(),
  home: '',
  gui: true,
  loaded: false,
  services: new Set<string>(),
  bootError: false,
  queryError: false,
  bridge: { path: '/private/tmp/private-env.sock', wait: vi.fn(), close: vi.fn() },
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => io.home,
}));
vi.mock('../../src/cli/launch-environment.js', async (original) => ({
  ...(await original<typeof import('../../src/cli/launch-environment.js')>()),
  environmentBridge: async () => io.bridge,
}));
import {
  launchdPaths,
  launchdPlist,
  configureLaunchdLogin,
  startLaunchd,
  unloadLaunchd,
} from '../../src/cli/launchd.js';
import type { CovroPaths } from '../../src/cli/paths.js';

let location: CovroPaths;
beforeEach(async () => {
  io.home = await mkdtemp(join(tmpdir(), 'c188-ld-'));
  location = {
    home: io.home,
    config: join(io.home, 'config & test.json'),
    key: 'test188',
    state: join(io.home, 'state'),
    log: join(io.home, 'state/covro.log'),
    logs: join(io.home, 'state/logs'),
    socket: join(io.home, 'control.sock'),
  };
  await mkdir(location.state);
  io.gui = true;
  io.loaded = false;
  io.services.clear();
  io.bootError = false;
  io.queryError = false;
  vi.clearAllMocks();
  io.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'print') {
      if (io.queryError)
        throw Object.assign(new Error('denied'), { stderr: 'Operation not permitted' });
      if (
        args[1]!.split('/').length === 2
          ? !io.gui
          : !io.services.has(args[1]!) && !(io.loaded && args[1] === launchdPaths(location).target)
      )
        throw Object.assign(new Error('missing'), { stderr: 'Could not find domain or service' });
    }
    if (args[0] === 'bootout') {
      io.services.delete(args[1]!);
      if (args[1] === launchdPaths(location).target) io.loaded = false;
    }
    if (args[0] === 'bootstrap') {
      if (io.bootError) throw new Error('bootstrap failed');
      const plist = await readFile(args[2]!, 'utf8');
      const label =
        /<key>Label<\/key><string>([^<]+)<\/string>/.exec(plist)?.[1] ??
        basename(args[2]!, '.plist');
      io.services.add(`${args[1]}/${label}`);
    }
    return { stdout: '', stderr: '' };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(io.home, { recursive: true, force: true });
});

it('creates an Aqua job without login auto-start, secret persistence, or crash respawn', async () => {
  vi.stubEnv('GH_TOKEN', 'fake-secret-188');
  io.loaded = true;
  expect(await startLaunchd(location, '/entry & space.mjs')).toBe(true);
  const files = launchdPaths(location);
  const plist = await readFile(files.temporary, 'utf8');
  expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>');
  expect(plist).toContain('/entry &amp; space.mjs');
  expect(plist).not.toMatch(/KeepAlive|SessionCreate|fake-secret-188|GH_TOKEN/);
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootout', files.target],
    expect.anything(),
  );
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootstrap', files.domain, files.temporary],
    expect.anything(),
  );
  await expect(readFile(files.login)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(io.bridge.wait).toHaveBeenCalledOnce();
  expect(io.bridge.close).toHaveBeenCalledOnce();
});

it('preserves explicit login registration across stop/restart and removes it on uninstall', async () => {
  const files = launchdPaths(location, `dev.covro.${location.key}`);
  await configureLaunchdLogin(location, '/legacy-entry', true);
  expect(await readFile(files.login, 'utf8')).toContain('KeepAlive');
  await startLaunchd(location, '/unused-entry');
  expect(io.bridge.wait).not.toHaveBeenCalled();
  await unloadLaunchd(location);
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootout', files.target],
    expect.anything(),
  );
  expect(await readFile(files.login, 'utf8')).toContain('/legacy-entry');
  await startLaunchd(location, '/unused-entry');
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootstrap', files.domain, files.login],
    expect.anything(),
  );
  await unloadLaunchd(location);
  await configureLaunchdLogin(location, '/legacy-entry', false);
  await expect(readFile(files.login)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(location.state, 'service.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('allows headless fallback only when no GUI domain exists and no login service is installed', async () => {
  io.gui = false;
  expect(await startLaunchd(location, '/entry')).toBe(false);
  expect(io.exec.mock.calls.some((call) => call[1][0] === 'bootstrap')).toBe(false);
  io.gui = true;
  await configureLaunchdLogin(location, '/entry', true);
  io.gui = false;
  await expect(startLaunchd(location, '/entry')).rejects.toThrow('桌面登录会话');
});

it('surfaces query errors instead of treating them as a missing desktop', async () => {
  io.queryError = true;
  await expect(startLaunchd(location, '/entry')).rejects.toThrow('launchd 权限');
  expect(io.bridge.wait).not.toHaveBeenCalled();
});

it('cleans up a failed launch and never falls back silently after a GUI bootstrap failure', async () => {
  io.bootError = true;
  await expect(startLaunchd(location, '/entry')).rejects.toThrow('GUI 后台启动失败');
  expect(io.bridge.close).toHaveBeenCalledOnce();
  await expect(readFile(launchdPaths(location).temporary)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('escapes plist arguments and restricts saved environment to documented paths', () => {
  vi.stubEnv('GH_TOKEN', 'fake-secret-188');
  vi.stubEnv('CODEX_HOME', '/codex & home');
  const plist = launchdPlist(location, ['a<b>"&'], true);
  expect(plist).toContain('a&lt;b&gt;&quot;&amp;');
  expect(plist).toContain('/codex &amp; home');
  expect(plist).not.toContain('fake-secret-188');
});

it('rejects a login registration belonging to a different instance', async () => {
  await writeFile(
    join(location.state, 'service.json'),
    JSON.stringify({ platform: 'darwin', label: 'dev.covro.other' }),
  );
  await expect(startLaunchd(location, '/entry')).rejects.toThrow('身份与当前配置不匹配');
  expect(io.exec).not.toHaveBeenCalled();
});

it('gives the same configuration in different application homes distinct jobs', () => {
  expect(launchdPaths(location).target).not.toBe(
    launchdPaths({ ...location, home: join(io.home, 'other-home') }).target,
  );
});

it('restarts and removes a legacy config-only login registration', async () => {
  const label = `dev.covro.${location.key}`;
  const files = launchdPaths(location, label);
  await mkdir(join(io.home, 'Library/LaunchAgents'), { recursive: true });
  await writeFile(files.login, '<legacy-plist/>');
  await writeFile(
    join(location.state, 'service.json'),
    JSON.stringify({ platform: 'darwin', label }),
  );
  await startLaunchd(location, '/entry');
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootstrap', files.domain, files.login],
    expect.anything(),
  );
  await unloadLaunchd(location);
  await configureLaunchdLogin(location, '/entry', false);
  await expect(readFile(files.login)).rejects.toMatchObject({ code: 'ENOENT' });
});

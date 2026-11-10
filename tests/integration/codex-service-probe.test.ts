import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }),
}));
import * as launch from '../../src/cli/runtime-launch.js';
import { launchdPlist } from '../../src/cli/launchd.js';
import { paths } from '../../src/cli/paths.js';
import { probeRestartCodex } from '../../src/updates/codex-target.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp('/tmp/c335-service-');
  io.exec.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(platform: 'linux' | 'darwin', extra = '') {
  const location = {
    ...paths(join(directory, 'config.json')),
    home: directory,
    state: join(directory, 'state'),
  };
  await mkdir(location.state);
  await writeFile(location.config, '{}');
  const source = { node: '/old/node', entry: '/old/covro', path: '/old/bin' };
  const target = { node: '/new/node', entry: '/new/covro', path: '/new/bin:/usr/bin' };
  const content =
    platform === 'darwin'
      ? launchdPlist(
          location,
          [source.node, source.entry, 'run', '--config', location.config],
          true,
          source.path,
        )
      : `[Unit]\nDescription=Covro\n[Service]\nExecStart="${source.node}" "${source.entry}" "run" "--config" "${location.config}"\nEnvironment="PATH=${source.path}" "COVRO_HOME=${directory}" "KEEP=service-value"\nWorkingDirectory=/service/cwd\nRestart=on-failure\n[Install]\nWantedBy=default.target\n${extra}`;
  vi.spyOn(launch, 'launchRuntime').mockResolvedValue(source);
  vi.spyOn(launch, 'snapshotLaunch').mockResolvedValue({
    runtime: source,
    service: { filename: join(directory, 'service'), content, platform },
  });
  const identity = {
    binary: 'codex',
    resolved: '/service/codex',
    executable: '/service/codex',
    file: 'file',
    version: '0.167.0',
    node: target.node,
    cwd: '/service/cwd',
    environment: 'service-environment',
  };
  return {
    location,
    source,
    target,
    identity,
    content,
    probe: () => probeRestartCodex(location, directory, target, source),
  };
}
it('uses a transient systemd user service with the rendered target PATH and preserved service environment/cwd', async () => {
  const f = await fixture('linux');
  io.exec.mockResolvedValue({ stdout: JSON.stringify({ identity: f.identity }) });
  expect((await f.probe()).identity).toEqual(f.identity);
  expect(io.exec).toHaveBeenCalledWith(
    'systemd-run',
    expect.arrayContaining([
      '--user',
      '--pipe',
      '--service-type=exec',
      `--property=Environment="PATH=${f.target.path}" "COVRO_HOME=${directory}" "KEEP=service-value"`,
      '--property=WorkingDirectory=/service/cwd',
      f.target.node,
      join(directory, 'dist/cli/codex-probe.js'),
      f.location.config,
    ]),
    expect.objectContaining({ timeout: 15_000 }),
  );
});
it.each([
  'EnvironmentFile=/custom/env\n',
  '[Service]\nExecStart=/other/covro\n',
  '[Service]\nWorkingDirectory=/other/cwd\n',
  'ExecStartPre=/custom/wrapper\n',
  'Environment="PATH=%h/custom"\n',
])('blocks unreproducible systemd source %s before invoking the manager', async (extra) => {
  const f = await fixture('linux', extra);
  await expect(f.probe()).rejects.toThrow('systemd');
  expect(io.exec).not.toHaveBeenCalled();
});
it('cleans up its launchd probe job and never starts the persistent Covro job', async () => {
  const f = await fixture('darwin');
  let probe: Record<string, unknown> | undefined;
  io.exec.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/usr/bin/plutil')
      return {
        stdout: JSON.stringify({
          Label: 'dev.covro.original',
          ProgramArguments: [],
          RunAtLoad: true,
          EnvironmentVariables: { PATH: f.target.path, CODEX_HOME: '/service/codex-home' },
          WorkingDirectory: '/service/cwd',
        }),
      };
    if (args[0] === 'bootstrap') {
      const text = await readFile(args[2]!, 'utf8');
      expect(text).toContain('<string>/new/node</string>');
      expect(text).toContain('<key>CODEX_HOME</key><string>/service/codex-home</string>');
      expect(text).toContain('<key>WorkingDirectory</key><string>/service/cwd</string>');
      expect(text).not.toContain('<key>KeepAlive</key>');
      const output = /<key>StandardOutPath<\/key><string>([^<]+)<\/string>/.exec(text)![1]!;
      probe = { output };
      await writeFile(output, JSON.stringify({ identity: f.identity }));
    }
    return { stdout: '' };
  });
  expect((await f.probe()).identity).toEqual(f.identity);
  expect(io.exec).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['bootout', expect.stringMatching(/\/dev\.covro\.probe\./)],
    expect.anything(),
  );
  await expect(readFile(String(probe!.output))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not expose failed manager output or environment values', async () => {
  const f = await fixture('linux');
  io.exec.mockRejectedValue(new Error('sensitive-service-value'));
  await expect(f.probe()).rejects.toThrow('服务管理器权限');
  await expect(f.probe()).rejects.not.toThrow('sensitive-service-value');
});

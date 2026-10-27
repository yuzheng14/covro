import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CovroPaths } from './paths.js';
import { launchdPaths } from './launchd.js';
import { readJson, saveJson } from '../updates/files.js';

const exec = promisify(execFile);
const schema = z
  .object({ node: z.string().startsWith('/'), entry: z.string().startsWith('/'), path: z.string() })
  .strict();
export type LaunchRuntime = z.infer<typeof schema>;
export const runtimeFile = (location: CovroPaths) => join(location.state, 'runtime.json');
export async function launchRuntime(location: CovroPaths, entry: string, override?: LaunchRuntime) {
  const saved = override ?? (await readJson(runtimeFile(location)));
  return saved
    ? schema.parse(saved)
    : { node: process.execPath, entry, path: process.env.PATH ?? '/usr/bin:/bin' };
}
export const systemdQuote = (value: string) =>
  `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export interface LaunchSnapshot {
  runtime?: LaunchRuntime;
  target?: LaunchRuntime;
  service?: { filename: string; content: string; platform: string };
}
function serviceContent(
  location: CovroPaths,
  runtime: LaunchRuntime,
  service: NonNullable<LaunchSnapshot['service']>,
) {
  const { content, platform } = service;
  const args = [runtime.node, runtime.entry, 'run', '--config', location.config];
  return platform === 'darwin'
    ? content
        .replace(
          /<key>ProgramArguments<\/key><array>.*?<\/array>/s,
          () =>
            `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>`,
        )
        .replace(
          /<key>PATH<\/key><string>[^<]*<\/string>/,
          () => `<key>PATH</key><string>${xml(runtime.path)}</string>`,
        )
    : content
        .replace(/^ExecStart=.*$/m, () => `ExecStart=${args.map(systemdQuote).join(' ')}`)
        .replace(/"PATH=(?:\\.|[^"\\])*"/, () => systemdQuote(`PATH=${runtime.path}`));
}

/** Read and validate the Covro-owned startup source before stopping anything. */
export async function snapshotLaunch(
  location: CovroPaths,
  current: LaunchRuntime,
): Promise<LaunchSnapshot> {
  const runtime = await readJson<LaunchRuntime>(runtimeFile(location));
  const installed = await readJson<{ platform: string; label: string }>(
    join(location.state, 'service.json'),
  );
  if (!installed) {
    if (process.env.INVOCATION_ID || process.env.PM2_HOME || process.env.SUPERVISOR_ENABLED)
      throw new Error('检测到外部进程管理器；请使用原管理器修改 Node 和 Covro 启动路径后重启。');
    return { runtime };
  }
  if (installed.platform !== process.platform || installed.label !== `dev.covro.${location.key}`)
    throw new Error('登录服务身份不匹配；请用目标 Node 重新安装 Covro 登录服务。');
  const filename =
    installed.platform === 'darwin'
      ? launchdPaths(location, installed.label).login
      : join(homedir(), '.config/systemd/user', `${installed.label}.service`);
  const content = await readFile(filename, 'utf8');
  const expected =
    installed.platform === 'darwin'
      ? `<key>ProgramArguments</key><array>${[current.node, current.entry, 'run', '--config', location.config].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>`
      : `ExecStart=${[current.node, current.entry, 'run', '--config', location.config].map(systemdQuote).join(' ')}`;
  if (!content.includes(expected))
    throw new Error(
      `服务启动来源与运行实例不匹配：${filename}；请核对自定义服务配置，当前服务保持运行。`,
    );
  if (installed.platform === 'linux') {
    const { stdout } = await exec(
      'systemctl',
      ['--user', 'show', `${installed.label}.service`, '--property=FragmentPath,DropInPaths'],
      { timeout: 5000 },
    );
    const properties = Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (properties.FragmentPath !== filename || properties.DropInPaths !== '')
      throw new Error(
        'systemd 实际加载来源与 Covro 服务文件不匹配或存在自定义 drop-in；请使用原部署方式更新。',
      );
  }
  return { runtime, service: { filename, content, platform: installed.platform } };
}

export async function switchLaunch(
  location: CovroPaths,
  runtime: LaunchRuntime,
  snapshot: LaunchSnapshot,
) {
  schema.parse(runtime);
  if (/[\r\n]/.test([runtime.node, runtime.entry, runtime.path].join('')))
    throw new Error('运行环境路径不能包含换行');
  snapshot.target = runtime;
  if (snapshot.service) {
    const { filename, content, platform } = snapshot.service;
    if ((await readFile(filename, 'utf8')) !== content)
      throw new Error('服务文件在升级期间被修改，拒绝覆盖。');
    const updated = serviceContent(location, runtime, snapshot.service);
    await writeFile(filename, updated, { mode: 0o600 });
    if (platform === 'linux')
      await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 });
  }
  await saveJson(runtimeFile(location), runtime);
}

export async function restoreLaunch(location: CovroPaths, snapshot: LaunchSnapshot) {
  if (snapshot.service) {
    const current = await readFile(snapshot.service.filename, 'utf8');
    if (
      current !== snapshot.service.content &&
      (!snapshot.target || current !== serviceContent(location, snapshot.target, snapshot.service))
    )
      throw new Error('服务文件已被外部修改，拒绝在恢复时覆盖；请保留现场并核对启动来源。');
    await writeFile(snapshot.service.filename, snapshot.service.content, { mode: 0o600 });
    if (snapshot.service.platform === 'linux')
      await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 });
  }
  const current = await readJson<LaunchRuntime>(runtimeFile(location));
  if (
    current &&
    snapshot.target &&
    ![snapshot.runtime, snapshot.target].some(
      (value) =>
        value &&
        value.node === current.node &&
        value.entry === current.entry &&
        value.path === current.path,
    )
  )
    throw new Error('实例启动来源已被外部修改，拒绝覆盖。');
  if (snapshot.runtime) await saveJson(runtimeFile(location), snapshot.runtime);
  else await rm(runtimeFile(location), { force: true });
}

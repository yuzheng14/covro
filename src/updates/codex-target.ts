import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { CovroPaths } from '../cli/paths.js';
import {
  launchRuntime,
  snapshotLaunch,
  serviceContent,
  systemdQuote,
  type LaunchRuntime,
} from '../cli/runtime-launch.js';
import { launchdPaths } from '../cli/launchd.js';
import type { CodexTarget } from '../shared/codex-identity.js';
import { assertCodexIdentity, type CodexIdentity } from '../codex/identity.js';

const execute = promisify(execFile);
class CodexTargetError extends Error {}
async function exec(
  command: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  try {
    return await execute(command, args, options);
  } catch {
    throw new CodexTargetError(
      '目标服务 Codex 探测未完成；请检查启动来源、Node、PATH 与服务管理器权限',
    );
  }
}
export type { CodexTarget } from '../shared/codex-identity.js';
const identity = z
  .object({
    binary: z.string(),
    resolved: z.string(),
    executable: z.string(),
    file: z.string(),
    version: z.string(),
    node: z.string(),
    cwd: z.string(),
    environment: z.string(),
  })
  .strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const codexConfiguration = async (config: string) => digest(await readFile(config, 'utf8'));
function result(stdout: string) {
  const value = z
    .object({ identity: identity.optional(), error: z.string().optional() })
    .parse(JSON.parse(stdout));
  if (!value.identity)
    throw new CodexTargetError('无法探测重启目标 Codex，请检查配置的 binary、Node 和目标 PATH');
  return value.identity;
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function plist(value: unknown): string {
  if (typeof value === 'string') return `<string>${xml(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`;
  if (value && typeof value === 'object')
    return `<dict>${Object.entries(value)
      .map(([key, entry]) => `<key>${xml(key)}</key>${plist(entry)}`)
      .join('')}</dict>`;
  throw new CodexTargetError('登录服务包含无法复现的启动属性');
}
/** A short-lived --version job in the same manager/domain, never another app-server. */
async function launchdProbe(location: CovroPaths, content: string, args: string[]) {
  // plutil reads a file, avoiding a shell and preserving literal environment values.
  const directory = await mkdtemp(join(location.state, 'codex-probe-'));
  const label = `dev.covro.probe.${randomUUID()}`;
  const target = `${launchdPaths(location).domain}/${label}`;
  let loaded = false;
  try {
    const filename = join(directory, 'probe.plist');
    await writeFile(filename, content, { mode: 0o600 });
    const parsed = JSON.parse(
      (await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filename], { timeout: 5000 }))
        .stdout,
    ) as Record<string, unknown>;
    const allowed = [
      'Label',
      'ProgramArguments',
      'LimitLoadToSessionType',
      'RunAtLoad',
      'KeepAlive',
      'ThrottleInterval',
      'EnvironmentVariables',
      'StandardOutPath',
      'StandardErrorPath',
      'WorkingDirectory',
    ];
    if (Object.keys(parsed).some((key) => !allowed.includes(key)))
      throw new CodexTargetError('自定义 launchd 启动属性无法可靠探测，请使用原部署方式更新');
    delete parsed.KeepAlive;
    delete parsed.ThrottleInterval;
    parsed.Label = label;
    parsed.ProgramArguments = args;
    parsed.RunAtLoad = true;
    parsed.StandardOutPath = join(directory, 'result.json');
    parsed.StandardErrorPath = join(directory, 'stderr');
    await writeFile(filename, `<?xml version="1.0"?><plist version="1.0">${plist(parsed)}</plist>`);
    await exec('/bin/launchctl', ['bootstrap', launchdPaths(location).domain, filename], {
      timeout: 5000,
    });
    loaded = true;
    for (let attempt = 0; attempt < 80; attempt++) {
      const output = await readFile(join(directory, 'result.json'), 'utf8').catch(() => '');
      if (output.trim()) return result(output);
      await setTimeout(100);
    }
    throw new CodexTargetError('登录服务未返回 Codex 探测结果，请检查目标 Node 与服务环境');
  } finally {
    if (loaded) await exec('/bin/launchctl', ['bootout', target], { timeout: 5000 });
    await rm(directory, { recursive: true, force: true });
  }
}
async function systemdProbe(content: string, args: string[]) {
  const properties: string[] = [];
  let environment = false;
  let command = false;
  let cwd = false;
  let section = '';
  for (const line of content
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (/^\[(Unit|Service|Install)\]$/.test(line)) {
      section = line;
      continue;
    }
    if (
      line.startsWith('#') ||
      (section === '[Unit]' && line.startsWith('Description=')) ||
      (section === '[Install]' && line.startsWith('WantedBy='))
    )
      continue;
    if (section !== '[Service]')
      throw new CodexTargetError('自定义 systemd 启动属性无法可靠探测，请使用原部署方式更新');
    if (line.startsWith('ExecStart=') && !command) {
      command = true;
      continue;
    }
    if (/^(Restart|RestartSec)=/.test(line)) continue;
    if (line.startsWith('Environment=') && !environment) {
      // Unit specifiers depend on the job name; a probe cannot reproduce them safely.
      if (line.includes('%'))
        throw new CodexTargetError('systemd 环境含动态 specifier，请使用原部署方式更新');
      environment = true;
      properties.push(`--property=${line}`);
    } else if (line.startsWith('WorkingDirectory=') && !line.includes('%') && !cwd) {
      cwd = true;
      properties.push(`--property=${line}`);
    } else throw new CodexTargetError('自定义 systemd 启动属性无法可靠探测，请使用原部署方式更新');
  }
  if (!environment || !command)
    throw new CodexTargetError('systemd 启动命令或环境缺失，请重新安装登录服务');
  const { stdout } = await exec(
    'systemd-run',
    [
      '--user',
      '--quiet',
      '--wait',
      '--pipe',
      '--collect',
      '--service-type=exec',
      '--expand-environment=no',
      `--unit=covro-codex-probe-${randomUUID()}`,
      ...properties,
      '--',
      ...args,
    ],
    { timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  return result(stdout);
}
async function observeRestartCodex(
  location: CovroPaths,
  root: string,
  target: LaunchRuntime,
  expectedSource?: LaunchRuntime,
  probeRoot = root,
): Promise<CodexTarget> {
  const current = await launchRuntime(location, join(root, 'bin/covro.mjs'));
  if (expectedSource && JSON.stringify(current) !== JSON.stringify(expectedSource))
    throw new CodexTargetError('保存的启动来源已变化，请重新检查更新');
  const snapshot = await snapshotLaunch(location, current);
  const configuration = await codexConfiguration(location.config);
  const args = [target.node, join(probeRoot, 'dist/cli/codex-probe.js'), location.config];
  let found: CodexIdentity;
  if (snapshot.service) {
    const content = serviceContent(location, target, snapshot.service);
    // The target PATH must be present in the rendered service, as it will be on restart.
    const path =
      snapshot.service.platform === 'darwin'
        ? `<key>PATH</key><string>${xml(target.path)}</string>`
        : systemdQuote(`PATH=${target.path}`);
    if (!content.includes(path))
      throw new CodexTargetError('服务缺少可确认的目标 PATH，请重新安装登录服务');
    found =
      snapshot.service.platform === 'darwin'
        ? await launchdProbe(location, content, args)
        : await systemdProbe(content, args);
  } else {
    const { stdout } = await exec(args[0]!, args.slice(1), {
      env: { ...process.env, PATH: target.path, COVRO_HOME: location.home },
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    found = result(stdout);
  }
  if (configuration !== (await codexConfiguration(location.config)))
    throw new CodexTargetError('配置在 Codex 探测期间变化，请重新检查');
  return {
    identity: found,
    configuration,
    launch: digest(JSON.stringify({ current, target, snapshot })),
  };
}
/** Keep arbitrary CLI/manager output and environment values out of status and logs. */
export async function probeRestartCodex(
  ...args: Parameters<typeof observeRestartCodex>
): Promise<CodexTarget> {
  try {
    return await observeRestartCodex(...args);
  } catch (error) {
    if (error instanceof CodexTargetError) throw error;
    throw new CodexTargetError(
      '无法确认重启目标 Codex；请检查配置、目标 PATH、Node 和服务启动来源后重新检查。',
    );
  }
}
export function assertCodexTarget(actual: CodexTarget, expected: CodexTarget) {
  assertCodexIdentity(actual.identity, expected.identity);
  if (actual.configuration !== expected.configuration || actual.launch !== expected.launch)
    throw new CodexTargetError('Codex 配置或服务启动来源已变化，请重新检查更新');
}

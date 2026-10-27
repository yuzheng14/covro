import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { CovroPaths } from './paths.js';
import { environmentBridge, launchRunner } from './launch-environment.js';
import { readJson, saveJson } from '../updates/files.js';
import type { LaunchRuntime } from './runtime-launch.js';

const exec = promisify(execFile);
const launchctl = (args: string[]) =>
  exec('/bin/launchctl', args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function failureDetail(error: unknown) {
  const failure = error as { killed?: boolean; stderr?: string };
  if (failure.killed) return 'launchctl 请求超时';
  return (failure.stderr?.trim() || (error instanceof Error ? error.message : '未知错误')).slice(
    0,
    1024,
  );
}

export function launchdPaths(
  location: CovroPaths,
  label = `dev.covro.${location.key}.${createHash('sha256').update(location.home).digest('hex').slice(0, 12)}`,
) {
  const domain = `gui/${process.getuid!()}`;
  return {
    label,
    domain,
    target: `${domain}/${label}`,
    temporary: join(location.state, 'launchd.plist'),
    login: join(homedir(), 'Library/LaunchAgents', `${label}.plist`),
  };
}

async function loaded(target: string) {
  try {
    await launchctl(['print', target]);
    return true;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    if (/Could not find (?:domain|service|specified service)/i.test(stderr)) return false;
    throw new Error(
      `无法查询 launchd ${target}：${failureDetail(error)}；请检查当前用户的 launchd 权限`,
      { cause: error },
    );
  }
}

export async function guiSessionAvailable(location: CovroPaths) {
  return loaded(launchdPaths(location).domain);
}

async function loginRegistration(location: CovroPaths) {
  const installed = await readJson<{ platform: string; label: string }>(
    join(location.state, 'service.json'),
  );
  if (installed?.platform !== 'darwin') return undefined;
  // Older releases used a config-only label; keep those installed login services operable.
  if (
    installed.label !== launchdPaths(location).label &&
    installed.label !== `dev.covro.${location.key}`
  )
    throw new Error('登录服务身份与当前配置不匹配');
  return installed;
}

export async function loginServiceInstalled(location: CovroPaths) {
  return Boolean(await loginRegistration(location));
}

export function launchdPlist(
  location: CovroPaths,
  args: string[],
  login: boolean,
  path = process.env.PATH ?? '/usr/bin:/bin',
) {
  const { label } = launchdPaths(location, login ? `dev.covro.${location.key}` : undefined);
  const environment = {
    PATH: path,
    COVRO_HOME: location.home,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
${login ? '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer>' : ''}
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join('')}</dict>
<key>StandardOutPath</key><string>${xml(location.log)}</string>
<key>StandardErrorPath</key><string>${xml(location.log)}</string>
</dict></plist>
`;
}

export async function unloadLaunchd(location: CovroPaths) {
  const { target, temporary } = launchdPaths(location);
  const installed = await loginRegistration(location);
  const targets = new Set([
    target,
    ...(installed ? [launchdPaths(location, installed.label).target] : []),
  ]);
  for (const serviceTarget of targets) {
    if (await loaded(serviceTarget)) {
      try {
        await launchctl(['bootout', serviceTarget]);
      } catch (error) {
        if (await loaded(serviceTarget)) throw error;
      }
    }
  }
  await rm(temporary, { force: true });
}

export async function configureLaunchdLogin(
  location: CovroPaths,
  entry: string,
  install: boolean,
  runtime?: LaunchRuntime,
) {
  // Preserve the installed label so older CLIs can still uninstall it after a rollback.
  const { label, login } = launchdPaths(location, `dev.covro.${location.key}`);
  const previous = await loginRegistration(location);
  if (install) {
    if (!(await guiSessionAvailable(location)))
      throw new Error('启用登录自启需要当前用户已登录 macOS 桌面');
    await mkdir(dirname(login), { recursive: true });
    await writeFile(
      login,
      launchdPlist(
        location,
        [runtime?.node ?? process.execPath, entry, 'run', '--config', location.config],
        true,
        runtime?.path,
      ),
      { mode: 0o600 },
    );
    await saveJson(join(location.state, 'service.json'), { platform: 'darwin', label });
    if (previous && previous.label !== label)
      await rm(launchdPaths(location, previous.label).login, { force: true });
  } else {
    if (previous) await rm(launchdPaths(location, previous.label).login, { force: true });
    await rm(login, { force: true });
    await rm(join(location.state, 'service.json'), { force: true });
  }
}

/** Caller holds the per-instance lifecycle lock and has verified the daemon is stopped. */
export async function startLaunchd(location: CovroPaths, entry: string, runtime?: LaunchRuntime) {
  const installed = await loginRegistration(location);
  const { domain, target, temporary, login } = launchdPaths(location, installed?.label);
  if (!(await guiSessionAvailable(location))) {
    if (installed) throw new Error('当前没有 macOS 桌面登录会话，无法启动 GUI 登录服务');
    return false;
  }
  await unloadLaunchd(location);
  if (installed) {
    await launchctl(['enable', target]);
    await launchctl(['bootstrap', domain, login]);
    return true;
  }
  const bridge = await environmentBridge(location.home, runtime?.path);
  try {
    const runner = join(location.state, 'launch-runner.mjs');
    await writeFile(runner, launchRunner, { mode: 0o600 });
    await writeFile(
      temporary,
      launchdPlist(
        location,
        [runtime?.node ?? process.execPath, runner, bridge.path, entry, location.config],
        false,
        runtime?.path,
      ),
      { mode: 0o600 },
    );
    await launchctl(['enable', target]);
    await launchctl(['bootstrap', domain, temporary]);
    await bridge.wait();
    return true;
  } catch (error) {
    let cleanup = '';
    try {
      await unloadLaunchd(location);
    } catch (cleanupError) {
      cleanup = `；清理任务失败：${failureDetail(cleanupError)}`;
    }
    throw new Error(
      `Covro GUI 后台启动失败：${failureDetail(error)}${cleanup}；进程日志位于 ${location.log}`,
      { cause: error },
    );
  } finally {
    await bridge.close();
  }
}

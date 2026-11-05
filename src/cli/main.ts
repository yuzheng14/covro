import { readLogs, parseSince, validateQuery, type LogQuery } from './logs.js';
import type { LogLevel } from '../logging/logger.js';
import { backupCommand } from './backup.js';
import type { UpdateStatus } from '../shared/updates.js';
import { join } from 'node:path';
import { control, isNotRunning } from './control.js';
import { startBackground as startManagedBackground, stopBackground } from './background.js';
import { randomUUID } from 'node:crypto';
import { ensureConfig, packageInfo, packageRoot, paths, type CovroPaths } from './paths.js';
import { runDaemon } from './daemon.js';
import { service } from './service.js';
import { UpdateManager } from '../updates/manager.js';
import { loadConfig } from '../server/config.js';

export function parseArguments(args: string[]) {
  const positional: string[] = [];
  let configPath: string | undefined;
  let channel: 'stable' | 'beta' | 'dev' | undefined;
  let confirm: string | undefined;
  let recoveryDataDir: string | undefined;
  const logQuery: LogQuery = {};
  let allowDowngrade = false;
  let allowUnverifiedCodex = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--follow') logQuery.follow = true;
    else if (arg === '--json') logQuery.json = true;
    else if (arg === '--thread' && args[i + 1]) logQuery.thread = args[++i];
    else if (arg === '--event' && args[i + 1]) logQuery.event = args[++i];
    else if (arg === '--level' && args[i + 1]) logQuery.level = args[++i] as LogLevel;
    else if (arg === '--since' && args[i + 1]) logQuery.since = parseSince(args[++i]!);
    else if (arg === '--lines' && args[i + 1]) logQuery.lines = Number(args[++i]);
    else if (arg === '--config' && args[i + 1]) configPath = args[++i];
    else if (arg === '--channel' && ['stable', 'beta', 'dev'].includes(args[i + 1] ?? ''))
      channel = args[++i] as typeof channel;
    else if (arg === '--confirm' && args[i + 1]) confirm = args[++i];
    else if (arg === '--data-dir' && args[i + 1]) recoveryDataDir = args[++i];
    else if (arg === '--allow-downgrade') allowDowngrade = true;
    else if (arg === '--allow-unverified-codex') allowUnverifiedCodex = true;
    else if (arg.startsWith('-') && arg !== '--help' && arg !== '--version')
      throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  const [command = 'start', subcommand, backupId] = positional;
  if (
    positional.length > (command === 'backup' ? 3 : ['service', 'update'].includes(command) ? 2 : 1)
  )
    throw new Error('Too many arguments');
  if (Object.keys(logQuery).length && command !== 'logs')
    throw new Error('Log options require covro logs');
  validateQuery(logQuery);
  if ((channel || allowDowngrade || allowUnverifiedCodex) && command !== 'update')
    throw new Error('升级选项仅用于 update');
  if ((confirm || recoveryDataDir) && command !== 'backup')
    throw new Error('恢复选项仅用于 backup');
  if (confirm && subcommand !== 'restore') throw new Error('--confirm 仅用于 backup restore');
  return {
    command,
    backupId,
    confirm,
    recoveryDataDir,
    subcommand,
    channel,
    allowDowngrade,
    allowUnverifiedCodex,
    logQuery,
    location: paths(configPath),
  };
}

export async function startBackground(location: CovroPaths) {
  try {
    return await control(location, 'status');
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }
  await ensureConfig(location);
  return startManagedBackground(location, join(packageRoot, 'bin/covro.mjs'));
}

export async function main(args = process.argv.slice(2)) {
  const {
    command,
    subcommand,
    backupId,
    confirm,
    recoveryDataDir,
    channel,
    allowDowngrade,
    allowUnverifiedCodex,
    location,
    logQuery,
  } = parseArguments(args);
  if (command === '--version') {
    console.log(packageInfo.version);
    return;
  }
  if (command === '--help' || command === 'help') {
    console.log(
      'Covro\n\ncovro [start|run|stop|status|doctor|logs] [--config FILE]\ncovro logs [--follow] [--thread ID] [--event EVENT] [--level LEVEL] [--since 1h] [--lines N] [--json]\ncovro update [status|repair] [--channel stable|beta|dev] [--allow-downgrade] [--allow-unverified-codex]\ncovro backup create|list|verify ID|restore ID|repair [--config FILE] [--confirm ID] [--data-dir DIR]\ncovro service install|uninstall [--config FILE]\n\n默认后台运行；service install 单独启用登录自启。doctor 从运行实例检查会话和 GitHub 凭证，不显示令牌。',
    );
    return;
  }
  if (command === 'backup') {
    console.log(
      JSON.stringify(
        await backupCommand(location, subcommand, backupId, confirm, recoveryDataDir),
        null,
        2,
      ),
    );
  } else if (command === 'start')
    console.log(JSON.stringify(await startBackground(location), null, 2));
  else if (command === 'run') {
    await ensureConfig(location);
    await runDaemon(location.config);
  } else if (command === 'update') {
    if (subcommand === 'repair') {
      const config = await loadConfig({ configPath: location.config, development: false });
      const manager = new UpdateManager(location, config.dataDir);
      console.log(JSON.stringify(await manager.repair(), null, 2));
      return;
    }
    if (subcommand && subcommand !== 'status') throw new Error('未知升级命令');
    await startBackground(location);
    let codexConfirmation;
    if (allowUnverifiedCodex && !subcommand) {
      const checked = await control<UpdateStatus>(location, 'update-check', { channel });
      const candidate = checked.available;
      if (candidate?.codex.status === 'unverified' && candidate.codex.version)
        codexConfirmation = { version: candidate.codex.version, target: candidate.version };
    }
    console.log(
      JSON.stringify(
        await control(
          location,
          subcommand === 'status' ? 'update-check' : 'update',
          subcommand === 'status'
            ? { channel }
            : { clientOperationId: randomUUID(), channel, allowDowngrade, codexConfirmation },
        ),
        null,
        2,
      ),
    );
  } else if (command === 'status' || command === 'stop' || command === 'doctor') {
    try {
      if (command === 'stop') {
        await stopBackground(location);
        console.log('Covro 已停止');
      } else console.log(JSON.stringify(await control(location, command), null, 2));
    } catch (error) {
      if (!isNotRunning(error)) throw error;
      console.log('Covro 未运行');
    }
  } else if (command === 'logs') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await readLogs(
        location.logs,
        logQuery,
        async (line) => {
          await new Promise<void>((resolve, reject) =>
            process.stdout.write(line + '\n', (error) => (error ? reject(error) : resolve())),
          );
        },
        controller.signal,
      );
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } else if (command === 'service' && ['install', 'uninstall'].includes(subcommand ?? '')) {
    await service(location, subcommand === 'install');
    console.log(subcommand === 'install' ? '已启用 Covro 登录自启' : '已取消 Covro 登录自启');
  } else throw new Error('未知命令，运行 covro --help 查看用法');
}

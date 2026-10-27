import { CODEX_COMPATIBILITY } from '../codex/compatibility.js';
import {
  assessCodexCompatibility,
  requireCodexCompatibility,
} from '../shared/codex-compatibility.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import {
  releaseChannels,
  updateActive,
  type UpdateController,
  type UpdateSettings,
  type UpdateRun,
  type UpdateStatus,
  type ReleaseChannel,
} from '../shared/updates.js';
import { packageInfo, packageRoot, type CovroPaths } from '../cli/paths.js';
import { readJson, saveJson } from './files.js';
import { compareVersions, inspectInstallation, lookupRelease } from './registry.js';
import {
  assertRuntime,
  resolveRuntimeTarget,
  runtimeChanged as changedRuntime,
  type RuntimeTarget,
} from './runtime.js';
import { runningRuntime } from '../cli/runtime.js';
import { launchRuntime, type LaunchRuntime } from '../cli/runtime-launch.js';
const runtimeChanged = (target: Parameters<typeof changedRuntime>[0]) =>
  changedRuntime(target, runningRuntime());

export const settingsSchema = z
  .object({ channel: z.enum(releaseChannels), automatic: z.boolean() })
  .strict();
export const updateRequestSchema = z
  .object({
    clientOperationId: z.uuid(),
    channel: z.enum(releaseChannels).optional(),
    allowDowngrade: z.boolean().optional(),
    codexConfirmation: z
      .object({ version: z.string().max(128), target: z.string().max(128) })
      .strict()
      .optional(),
  })
  .strict();
export interface UpdateContext {
  location: CovroPaths;
  dataDir: string;
  root: string;
  directory: string;
  target?: RuntimeTarget;
  reuseTarget?: boolean;
  source?: LaunchRuntime;
}
export class UpdateManager implements UpdateController {
  private settings: UpdateSettings = {
    channel:
      packageInfo.covroChannel ??
      (packageInfo.version?.includes('-dev.')
        ? 'dev'
        : packageInfo.version?.includes('-beta.')
          ? 'beta'
          : 'stable'),
    automatic: false,
  };
  private available?: UpdateStatus['available'];
  private checkedAt?: number;
  private checkError?: string;
  private target?: RuntimeTarget;
  private runtimeError?: string;
  private reason = '当前服务未通过 covro 启动，网页仅支持版本检测；升级请使用原部署方式。';
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<UpdateStatus>;
  private readonly network = new AbortController();
  readonly context?: UpdateContext;
  constructor(
    location?: CovroPaths,
    dataDir?: string,
    private readonly codexVersion: () => string | null = () => null,
  ) {
    if (location && dataDir)
      this.context = {
        location,
        dataDir,
        root: packageRoot,
        directory: join(
          location.home,
          'updates',
          createHash('sha256').update(packageRoot).digest('hex').slice(0, 16),
        ),
      };
  }
  async initialize() {
    if (!this.context) return;
    await this.loadDirectory();
    const saved = await readJson<unknown>(join(this.context.directory, 'settings.json'));
    if (saved !== undefined) this.settings = settingsSchema.parse(saved);
    this.reason =
      process.platform === 'win32'
        ? 'Windows 暂不支持受管自动升级，请使用 npm 更新并重启。'
        : ((await inspectInstallation(this.context.root)) ?? '');
    this.timer = setInterval(() => void this.automatic().catch(() => {}), 30 * 60_000);
    this.timer.unref();
    // No network request in the startup critical path.
    void this.automatic().catch(() => {});
  }
  private async loadDirectory() {
    if (!this.context) return;
    const saved = await readJson<{ directory: string }>(
      join(this.context.location.state, 'updates.json'),
    );
    if (saved) {
      const directory = resolve(saved.directory);
      if (!directory.startsWith(resolve(this.context.location.home, 'updates') + sep))
        throw new Error('升级记录目录不在 Covro 管理目录中');
      this.context.directory = directory;
    }
  }
  async status(): Promise<UpdateStatus> {
    const run = this.context
      ? await readJson<UpdateRun>(join(this.context.directory, 'run.json'))
      : undefined;
    return {
      version: packageInfo.version ?? 'unknown',
      commit: packageInfo.covroCommit,
      source: 'npm',
      codex: assessCodexCompatibility(CODEX_COMPATIBILITY, this.codexVersion()),
      settings: this.settings,
      supported: !this.reason,
      unsupportedReason: this.reason || undefined,
      available: this.available
        ? {
            ...this.available,
            codex: assessCodexCompatibility(this.available.codex.manifest, this.codexVersion()),
          }
        : undefined,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      run,
      runtime: {
        current: runningRuntime(),
        target: this.target,
        migration: Boolean(this.target && runtimeChanged(this.target)),
        error: this.runtimeError,
      },
    };
  }
  async check(channel: ReleaseChannel = this.settings.channel) {
    this.target = undefined;
    this.runtimeError = undefined;
    if (this.context && !this.reason) {
      try {
        this.target = await resolveRuntimeTarget();
      } catch (error) {
        this.runtimeError = (error as Error).message;
      }
    }
    try {
      const local = this.target && runtimeChanged(this.target) ? this.target : undefined;
      let release;
      try {
        release = await lookupRelease(channel, this.network.signal);
      } catch (error) {
        if (!local) throw error;
      }
      // A preinstalled newer target must never be overwritten by an older channel tag.
      if (local && (!release || compareVersions(local.version, release.version) >= 0))
        release = {
          version: local.version,
          channel: (local.version.includes('-dev.')
            ? 'dev'
            : local.version.includes('-beta.')
              ? 'beta'
              : 'stable') as ReleaseChannel,
          covroCommit: local.covroCommit,
          gitHead: undefined,
          covroCodex: local.covroCodex,
        };
      if (!release) throw new Error('未找到可用版本');
      this.available = {
        version: release.version,
        requestedChannel: channel,
        channel: release.channel,
        commit: release.covroCommit ?? release.gitHead,
        downgrade: compareVersions(release.version, packageInfo.version) < 0,
        codex: assessCodexCompatibility(release.covroCodex, this.codexVersion()),
      };
      this.checkError = undefined;
    } catch (error) {
      this.available = undefined;
      this.checkError = error instanceof Error ? error.message : '无法检查更新';
    }
    this.checkedAt = Date.now();
    return this.status();
  }
  async configure(input: UpdateSettings) {
    if (!this.context || this.reason) throw new AppError('UPDATE_UNSUPPORTED', this.reason, 409);
    this.settings = settingsSchema.parse(input);
    await saveJson(join(this.context.directory, 'settings.json'), this.settings);
    return this.status();
  }
  async activationPending() {
    const run = (await this.status()).run;
    if (
      run &&
      !run.committed &&
      ['failed', 'rolledBack'].includes(run.phase) &&
      (run.from !== packageInfo.version || (run.runtime && runtimeChanged(run.runtime.from)))
    )
      throw new Error(
        '上次升级尚未完成恢复；请运行 covro update repair 后再启动，避免写入未激活版本。',
      );
    if (run && !run.committed && run.phase === 'stopping')
      throw new Error('升级正在切换安装，请等待升级完成；不要并行启动服务。');
    if (run && !run.committed && run.phase === 'verifying') {
      if (run.target !== packageInfo.version)
        throw new Error('升级候选身份不匹配，请运行 covro update repair');
      if (run.runtime) assertRuntime(runningRuntime(), run.runtime.target);
      return true;
    }
    return false;
  }
  async commitActivation(id: string) {
    if (!this.context) throw new Error('当前不是受管安装');
    const run = (await this.status()).run;
    if (!run || run.id !== id || run.phase !== 'verifying' || run.target !== packageInfo.version)
      throw new Error('升级记录、版本或运行状态不匹配');
    if (run.runtime) assertRuntime(runningRuntime(), run.runtime.target);
    if (!run.codex || run.codex.version !== this.codexVersion())
      throw new Error('Codex 版本在升级期间发生变化或缺少校验记录，拒绝激活');
    requireCodexCompatibility(
      CODEX_COMPATIBILITY,
      this.codexVersion(),
      run.codex.confirmedUnverified,
    );
    this.settings = { ...this.settings, channel: run.channel };
    await saveJson(join(this.context.directory, 'settings.json'), this.settings);
    await saveJson(join(this.context.directory, 'run.json'), {
      ...run,
      committed: true,
      phase: 'succeeded',
      message: '升级成功，服务已恢复',
      updatedAt: Date.now(),
      runtime: run.runtime ? { ...run.runtime, actual: runningRuntime() } : undefined,
    });
  }
  async start(input: z.infer<typeof updateRequestSchema>) {
    const request = updateRequestSchema.parse(input);
    if (!this.context || this.reason) throw new AppError('UPDATE_UNSUPPORTED', this.reason, 409);
    await mkdir(this.context.directory, { recursive: true, mode: 0o700 });
    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await lockfile.lock(this.context.directory, {
        retries: 0,
        stale: 10_000,
        update: 2_000,
      });
    } catch {
      return this.status();
    }
    try {
      const before = await this.status();
      if (
        await readJson(
          join(this.context.directory, 'requests', `${request.clientOperationId}.json`),
        )
      )
        return before;
      if (before.run?.id === request.clientOperationId) return before;
      if (updateActive(before.run)) {
        if (Date.now() - before.run!.updatedAt > 120_000)
          throw new AppError(
            'UPDATE_INTERRUPTED',
            '上次升级进程已失联。请使用 covro update repair 恢复，保留当前安装和备份。',
            409,
          );
        return before;
      }
      const channel = request.channel ?? this.settings.channel;
      const checked = await this.check(channel);
      const target = this.target;
      if (this.runtimeError || !target)
        throw new AppError(
          'UPDATE_RUNTIME',
          this.runtimeError ?? '无法确认目标 Node 环境，请重新检查。',
          409,
        );
      if (!checked.available)
        throw new AppError('UPDATE_CHECK_FAILED', checked.checkError ?? '未找到可用版本', 502);
      if (checked.available.downgrade && !request.allowDowngrade)
        throw new AppError(
          'UPDATE_DOWNGRADE',
          '目标版本较旧，需要明确允许降级；仍将检查数据库兼容性。',
          409,
        );
      if (
        compareVersions(checked.available.version, packageInfo.version) === 0 &&
        !runtimeChanged(target)
      ) {
        return this.configure({ ...this.settings, channel });
      }
      const confirmation = request.codexConfirmation;
      const codex = checked.available.codex;
      const confirmedUnverified = Boolean(
        confirmation &&
        confirmation.target === checked.available.version &&
        confirmation.version === codex.version,
      );
      if (confirmation && !confirmedUnverified)
        throw new AppError(
          'UPDATE_CODEX_CHANGED',
          '目标版本或 Codex 已变化，请重新检查并确认。',
          409,
        );
      try {
        requireCodexCompatibility(codex.manifest, codex.version, confirmedUnverified);
      } catch (error) {
        throw new AppError('UPDATE_CODEX_INCOMPATIBLE', (error as Error).message, 409);
      }
      const run: UpdateRun = {
        id: request.clientOperationId,
        from: packageInfo.version,
        target: checked.available.version,
        channel,
        sourceChannel: checked.available.channel,
        commit: checked.available.commit,
        codex: { version: codex.version!, manifest: codex.manifest!, confirmedUnverified },
        phase: 'installing',
        message: '正在安装候选 npm 包',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        runtime: { from: runningRuntime(), target: target },
      };
      const currentLaunch = await launchRuntime(this.context.location, runningRuntime().entry);
      if (currentLaunch.node !== process.execPath || currentLaunch.entry !== runningRuntime().entry)
        throw new AppError(
          'UPDATE_RUNTIME',
          '保存的启动来源与当前实例不一致，请核对实例后重试。',
          409,
        );
      const context = {
        ...this.context,
        source: currentLaunch,
        target: target,
        reuseTarget:
          runtimeChanged(target) &&
          target.root !== this.context.root.replace(/\/$/, '') &&
          target.version === run.target,
      };
      await saveJson(join(this.context.directory, 'context.json'), context);
      await saveJson(join(this.context.location.state, 'updates.json'), {
        directory: this.context.directory,
      });
      const worker = join(this.context.directory, 'worker.cjs');
      await copyFile(join(packageRoot, 'dist/update-worker.cjs'), worker);
      const log = await open(join(this.context.directory, 'update.log'), 'a', 0o600);
      try {
        await saveJson(join(this.context.directory, 'run.json'), run);
        await saveJson(
          join(this.context.directory, 'requests', `${request.clientOperationId}.json`),
          { target: run.target, channel: run.channel },
        );
        const child = spawn(process.execPath, [worker, this.context.directory], {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          windowsHide: true,
        });
        await new Promise<void>((done, reject) => {
          child.once('spawn', done);
          child.once('error', reject);
        });
        child.unref();
      } catch (error) {
        await saveJson(join(this.context.directory, 'run.json'), {
          ...run,
          phase: 'failed',
          message: String(error),
          updatedAt: Date.now(),
        });
        throw error;
      } finally {
        await log.close();
      }
      return this.status();
    } finally {
      await releaseLock();
    }
  }
  async repair() {
    if (!this.context) throw new Error('没有可恢复的受管安装');
    await this.loadDirectory();
    const directory = this.context.directory;
    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await lockfile.lock(directory, { retries: 0, stale: 10_000, update: 2_000 });
    } catch {
      throw new Error('升级进程仍持有锁，请等待完成后再恢复');
    }
    try {
      const run = (await this.status()).run;
      if (!run) throw new Error('没有可恢复的升级记录');
      if (run.committed || run.phase === 'succeeded') return this.status();
      if (updateActive(run) && Date.now() - run.updatedAt < 30_000)
        throw new Error('升级刚开始，请等待至少 30 秒后再恢复失联进程');
      const log = await open(join(directory, 'update.log'), 'a', 0o600);
      try {
        const child = spawn(
          process.execPath,
          [join(directory, 'worker.cjs'), directory, '--repair'],
          {
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
            windowsHide: true,
          },
        );
        await new Promise<void>((done, reject) => {
          child.once('spawn', done);
          child.once('error', reject);
        });
        child.unref();
      } finally {
        await log.close();
      }
      return this.status();
    } finally {
      await releaseLock();
    }
  }
  private async automatic() {
    if (!this.context || this.reason || this.checking) return;
    this.checking = (async () => {
      const result = await this.check();
      if (
        this.settings.automatic &&
        result.available &&
        result.available.codex.status === 'verified' &&
        !result.available.downgrade &&
        compareVersions(result.available.version, packageInfo.version) > 0 &&
        result.run?.target !== result.available.version &&
        !updateActive(result.run)
      )
        return this.start({ clientOperationId: crypto.randomUUID() });
      return result;
    })();
    try {
      await this.checking;
    } finally {
      this.checking = undefined;
    }
  }
  close() {
    this.network.abort();
    clearInterval(this.timer);
  }
}

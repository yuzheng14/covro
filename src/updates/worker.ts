import { BackupStore, backupDirectory, verifyLegacySnapshot } from '../backups/store.js';
import { acquireMaintenanceLock } from '../backups/lock.js';
import { acquireInstanceLock } from '../server/instance-lock.js';
import { inspectDatabase, readMigrations } from '../server/db/history.js';
import { databaseCompatibilitySchema } from '../shared/database.js';
import { npmPackageName } from '../shared/package.js';
import {
  codexCompatibilitySchema,
  requireCodexCompatibility,
} from '../shared/codex-compatibility.js';
// Bundled with its pure JavaScript dependencies and copied outside the installation before launch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { access, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type Database from 'better-sqlite3';
import type { UpdateRun, RuntimeIdentity } from '../shared/updates.js';
import type { UpdateContext } from './manager.js';
import { control, isNotRunning } from '../cli/control.js';
import { startBackground, stopBackground } from '../cli/background.js';
import { copyDurable, readJson, saveJson } from './files.js';
import { activateUpdate, transactionPaths } from './transaction.js';
import { inspectInstallation, registry } from './registry.js';
import {
  assertRuntime,
  resolveRuntimeTarget,
  targetNpmEnvironment,
  verifyRuntimeExecutable,
} from './runtime.js';
import {
  snapshotLaunch,
  switchLaunch,
  restoreLaunch,
  type LaunchSnapshot,
} from '../cli/runtime-launch.js';

const exec = promisify(execFile);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type DaemonStatus = {
  version: string;
  pid: number;
  maintenance?: boolean;
  codexVersion?: string | null;
  codexReady?: boolean;
  runtime?: RuntimeIdentity;
};

async function startService(context: UpdateContext, candidate = false) {
  // Shared with `covro start`: never inherit a Background security session on macOS.
  // Activation is checked from the durable update record by the daemon.
  const target = candidate ? context.target : undefined;
  await startBackground(
    context.location,
    join(context.root, 'bin/covro.mjs'),
    target ? { node: target.node, entry: target.entry, path: target.path } : context.source,
  );
}
async function stopService(context: UpdateContext) {
  await stopBackground(context.location);
}

async function verifyRestoredService(context: UpdateContext, version: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const restored = await control<DaemonStatus>(context.location, 'status');
      if (restored.version !== version || restored.maintenance)
        throw new Error('旧版恢复身份不匹配');
      const record = await readJson<UpdateRun>(join(context.directory, 'run.json'));
      if (record?.runtime) assertRuntime(restored.runtime, record.runtime.from);
      return;
    } catch (error) {
      if (attempt === 239) throw error;
    }
    await setTimeout(250);
  }
}

async function verifyMigrations(context: UpdateContext, candidate: string) {
  // Loading the existing native addon happens before any package path is replaced.
  const require = createRequire(join(context.root, 'package.json'));
  const Sqlite = require('better-sqlite3') as typeof Database;
  const filename = join(context.dataDir, 'app.sqlite');
  try {
    await access(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const db = new Sqlite(filename, { readonly: true, fileMustExist: true });
  try {
    const migrations = readMigrations(join(candidate, 'dist/drizzle'));
    const metadata = await readJson<{ covroDatabase?: unknown }>(join(candidate, 'package.json'));
    if (metadata?.covroDatabase) {
      const contract = databaseCompatibilitySchema.parse(metadata.covroDatabase);
      if (contract.schemaVersion !== migrations.length)
        throw new Error('目标版本的 Schema 声明与迁移不一致');
    }
    inspectDatabase(db, migrations);
  } finally {
    db.close();
  }
}

async function worker(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    stale: 10_000,
    update: 2_000,
    retries: { retries: 30, minTimeout: 100, maxTimeout: 500 },
  });
  let record = await readJson<UpdateRun>(join(directory, 'run.json'));
  const context = await readJson<UpdateContext>(join(directory, 'context.json'));
  if (!record || !context) {
    await release();
    throw new Error('缺少升级记录');
  }
  const update = async (phase: UpdateRun['phase'], detail: string) => {
    record = { ...record!, phase, message: detail, updatedAt: Date.now() };
    await saveJson(join(directory, 'run.json'), record);
  };
  const paths = transactionPaths(
    context.target?.root ?? context.root,
    record.id,
    context.dataDir,
    context.location.config,
    join(backupDirectory(context.location.home, context.dataDir), record.id),
  );
  let releaseMaintenance: (() => Promise<void>) | undefined;
  let releaseData: (() => Promise<void>) | undefined;
  try {
    if (record.runtime) await verifyRuntimeExecutable(record.runtime.from);
    const previousMetadata = await readJson<{ version: string }>(
      join(paths.previous, 'package.json'),
    );
    const sameRoot = paths.root.replace(/\/$/, '') === context.root.replace(/\/$/, '');
    const originalRoot =
      sameRoot && previousMetadata?.version === record.from ? paths.previous : context.root;
    const originalMetadata = await readJson<{
      version: string;
      covroCommit?: string;
      covroDatabase?: unknown;
    }>(join(originalRoot, 'package.json'));
    const Sqlite = createRequire(join(originalRoot, 'package.json'))(
      'better-sqlite3',
    ) as typeof Database;
    const migrations = readMigrations(join(originalRoot, 'dist/drizzle'));
    const backups = new BackupStore({
      directory: backupDirectory(context.location.home, context.dataDir),
      config: paths.config,
      dataDir: paths.dataDir,
      appVersion: record.from,
      commit: originalMetadata?.covroCommit,
      contract: databaseCompatibilitySchema.parse(
        originalMetadata?.covroDatabase ?? {
          schemaVersion: migrations.length,
          minRestorableSchemaVersion: 1,
          backupFormatVersion: 1,
        },
      ),
      Sqlite,
      migrations,
    });
    if (process.argv[3] === '--repair') {
      releaseMaintenance = await acquireMaintenanceLock(context.dataDir);
      if (!(await readJson(join(paths.backup, 'snapshot.json'))))
        paths.backup = join(directory, `backup-${record.id}`);
      const active = await control<DaemonStatus>(context.location, 'status').catch(
        (error: unknown) => {
          if (isNotRunning(error)) return undefined;
          throw error;
        },
      );
      if (record.committed) return;
      if (active && !active.maintenance && active.version !== record.from)
        throw new Error('当前服务可能已接受新版业务数据；拒绝恢复旧快照，请使用兼容版本检查。');
      const previous = await readJson<{ version: string; name: string }>(
        join(paths.previous, 'package.json'),
      );
      if (previous || context.reuseTarget) {
        if (active && !active.maintenance)
          throw new Error('旧服务已恢复业务写入；拒绝用升级前快照覆盖现有数据，请保留现场检查。');
        if (
          previous &&
          (previous.name !== npmPackageName ||
            previous.version !== (context.target?.version ?? record.from))
        )
          throw new Error('旧版备份身份不匹配');
        const snapshot = await readJson<{ complete: boolean; formatVersion?: number }>(
          join(paths.backup, 'snapshot.json'),
        );
        if (snapshot?.formatVersion === 1) {
          const verified = await backups.verify(record.id);
          if (
            verified.appVersion !== record.from ||
            verified.protectedBy !== record.id ||
            verified.configPath !== paths.config ||
            verified.dataDir !== paths.dataDir
          )
            throw new Error('备份身份不匹配');
        } else await verifyLegacySnapshot(paths.backup, Sqlite, join(originalRoot, 'dist/drizzle'));
      } else if (sameRoot) {
        const original = await readJson<{ name: string; version: string }>(
          join(paths.root, 'package.json'),
        );
        if (original?.name !== npmPackageName || original.version !== record.from)
          throw new Error('未找到完整的上一版本安装');
      }
      if (active && !active.maintenance) {
        const admission = await control<{ ready: boolean }>(context.location, 'prepare-update');
        if (!admission.ready) throw new Error('仍有任务、审批或待核对操作，不能恢复旧安装');
      }
      await stopService(context);
      releaseData = await acquireInstanceLock(context.dataDir);
      if (previous) {
        await rm(paths.root, { recursive: true, force: true });
        await rename(paths.previous, paths.root);
      }
      if (previous || context.reuseTarget) {
        for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
          await rm(join(paths.dataDir, name), { force: true });
          try {
            await copyDurable(join(paths.backup, name), join(paths.dataDir, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await copyDurable(join(paths.backup, 'config.json'), paths.config);
      }
      const launch = await readJson<LaunchSnapshot>(join(directory, `launch-${record.id}.json`));
      if (launch) await restoreLaunch(context.location, launch);
      const restored = await readJson<{ name: string; version: string }>(
        join(context.root, 'package.json'),
      );
      if (restored?.name !== npmPackageName || restored.version !== record.from)
        throw new Error('未找到完整的上一版本安装');
      await update('rolledBack', '已恢复上次未完成的升级，正在启动上一版本');
      try {
        await releaseData?.();
        releaseData = undefined;
        await startService(context);
        await verifyRestoredService(context, record.from);
        await update('rolledBack', '已恢复上次未完成的升级，上一版本已就绪');
      } catch (error) {
        await update('failed', `旧版恢复启动失败，保留备份：${message(error)}`);
        throw error;
      }
      return;
    }
    const reason = await inspectInstallation(context.root);
    if (reason) throw new Error(reason);
    // A second managed configuration must be stopped before replacing their shared npm package.
    for (const key of await readdir(join(context.location.home, 'instances'))) {
      if (key === context.location.key) continue;
      const instance = await readJson<{ root: string; config: string; socket: string }>(
        join(context.location.home, 'instances', key, 'instance.json'),
      );
      if (
        !instance ||
        ![context.root.replace(/\/$/, ''), paths.root].includes(instance.root.replace(/\/$/, ''))
      )
        continue;
      try {
        await control({ ...context.location, socket: instance.socket }, 'status');
        throw new Error('同一 npm 安装还有其他 Covro 实例，请先停止其他实例再升级。');
      } catch (error) {
        if (!isNotRunning(error)) throw error;
      }
    }
    await access(dirname(context.root), constants.W_OK);
    await access(dirname(paths.root), constants.W_OK);
    if (context.target) {
      const target = await resolveRuntimeTarget();
      assertRuntime(target, context.target);
      if (
        target.npm !== context.target.npm ||
        target.npmVersion !== context.target.npmVersion ||
        target.prefix !== context.target.prefix ||
        target.path !== context.target.path ||
        target.version !== context.target.version
      )
        throw new Error('目标 Node/npm 环境在检查后变化，请重新检查更新。');
    }
    const candidateRoot = context.reuseTarget ? paths.root : paths.candidate;
    const node = context.target?.node ?? process.execPath;
    const env = targetNpmEnvironment(
      context.target?.path ?? process.env.PATH ?? '/usr/bin:/bin',
      context.target?.npmConfig,
    );
    // npm global layout keeps production dependencies nested in the package being swapped.
    if (!context.reuseTarget)
      await exec(
        context.target?.node ?? 'npm',
        [
          ...(context.target ? [context.target.npm] : []),
          'install',
          '--global',
          '--prefix',
          paths.prefix,
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          `--registry=${registry}`,
          '--allow-scripts=better-sqlite3',
          `${npmPackageName}@${record.target}`,
        ],
        { env, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 },
      );
    const candidate = await readJson<{
      name: string;
      version: string;
      covroCodex?: unknown;
      covroCommit?: string;
      gitHead?: string;
    }>(join(candidateRoot, 'package.json'));
    if (candidate?.name !== npmPackageName || candidate.version !== record.target)
      throw new Error('候选包身份或版本不匹配');
    if (record.commit && (candidate.covroCommit ?? candidate.gitHead) !== record.commit)
      throw new Error('候选包源码提交与检查时不一致，拒绝切换');
    if (!record.codex) throw new Error('缺少 Codex 升级校验记录，请重新检查更新');
    const manifest = codexCompatibilitySchema.parse(candidate.covroCodex);
    if (JSON.stringify(manifest) !== JSON.stringify(record.codex.manifest))
      throw new Error('候选包的 Codex 兼容声明与检查时不一致，拒绝切换');
    const checkCodex = async (current?: DaemonStatus) => {
      const state = current ?? (await control<DaemonStatus>(context.location, 'status'));
      if (state.codexVersion !== record!.codex!.version)
        throw new Error('Codex 版本在等待升级期间发生变化，请重新检查更新');
      requireCodexCompatibility(
        manifest,
        state.codexVersion ?? null,
        record!.codex!.confirmedUnverified,
      );
    };
    await checkCodex();
    const versionProbe = await exec(node, [join(candidateRoot, 'bin/covro.mjs'), '--version'], {
      timeout: 30_000,
      env,
    });
    if (versionProbe.stdout.trim() !== record.target)
      throw new Error('目标 Node 执行 Covro 入口后返回的版本不匹配');
    const nativeProbe =
      'const {createRequire}=await import("node:module"); const r=createRequire(process.argv[1]); const DB=r("better-sqlite3"); const db=new DB(":memory:"); db.close();';
    await exec(
      node,
      ['--input-type=module', '-e', nativeProbe, join(candidateRoot, 'package.json')],
      { env, timeout: 30_000 },
    );
    await verifyMigrations(context, candidateRoot);
    const launch: LaunchSnapshot = await snapshotLaunch(
      context.location,
      context.source ?? {
        node: process.execPath,
        entry: join(context.root, 'bin/covro.mjs'),
        path: process.env.PATH ?? '/usr/bin:/bin',
      },
    );
    if (context.target)
      launch.target = { node, entry: context.target.entry, path: context.target.path };
    await saveJson(join(directory, `launch-${record.id}.json`), launch);
    releaseMaintenance = await acquireMaintenanceLock(context.dataDir);
    await activateUpdate(
      paths,
      {
        backup: async () => {
          releaseData = await acquireInstanceLock(context.dataDir);
          await backups.create({ id: record!.id, trigger: 'preUpgrade', protectedBy: record!.id });
        },
        restore: async () => {
          releaseData ??= await acquireInstanceLock(context.dataDir);
          await backups.restoreFiles(record!.id);
        },
        switchLaunch: context.target
          ? () =>
              switchLaunch(
                context.location,
                { node, entry: context.target!.entry, path: context.target!.path },
                launch,
              )
          : undefined,
        restoreLaunch: () => restoreLaunch(context.location, launch),
        phase: update,
        waitForIdle: async () => {
          // Queue without blocking normal work; admission closes atomically only after all blockers clear.
          for (;;) {
            await checkCodex();
            const result = await control<{ ready: boolean; reason?: string }>(
              context.location,
              'prepare-update',
            );
            if (result.ready) {
              await checkCodex();
              return;
            }
            await update('waiting', result.reason ?? '等待所有任务结束');
            await setTimeout(2_000);
          }
        },
        stop: () => stopService(context),
        start: async (candidate) => {
          await releaseData?.();
          releaseData = undefined;
          await startService(context, candidate);
          if (!candidate) await verifyRestoredService(context, record!.from);
        },
        verify: async () => {
          for (let attempt = 0; attempt < 240; attempt++) {
            const current = await control<DaemonStatus>(context.location, 'status').catch(
              () => undefined,
            );
            if (current) {
              if (current.version !== record!.target || !current.maintenance)
                throw new Error('新版服务身份或维护状态不匹配');
              if (record!.runtime) assertRuntime(current.runtime, record!.runtime.target);
              await checkCodex(current);
              if (current.codexReady) return;
            }
            await setTimeout(250);
          }
          throw new Error('新版服务或 Codex 连接未就绪，拒绝激活');
        },
        commit: async () => {
          // Gateway commits the durable result before reopening task admission.
          await control(context.location, 'activate-update', {
            id: record!.id,
            channel: record!.channel,
          });
          const final = await readJson<UpdateRun>(join(directory, 'run.json'));
          if (!final?.committed) throw new Error('新版尚未确认升级提交');
          record = final;
        },
        hasCommitted: async () =>
          Boolean((await readJson<UpdateRun>(join(directory, 'run.json')))?.committed),
        resume: async () => {
          await control(context.location, 'cancel-update').catch(() => {});
        },
      },
      context.reuseTarget,
    );
  } catch (error) {
    const latest = await readJson<UpdateRun>(join(directory, 'run.json'));
    if (latest?.committed) {
      // A lost commit response cannot authorize restoring older data.
      record = latest;
    } else if (!['rolledBack', 'failed'].includes(record.phase))
      await update('failed', message(error));
    console.error(message(error));
    process.exitCode = record.committed || record.phase === 'rolledBack' ? 0 : 1;
  } finally {
    await releaseData?.();
    await releaseMaintenance?.();
    await release();
    // Keep the last good installation and database backup for explicit recovery.
    if (record.phase === 'succeeded' || record.phase === 'rolledBack') {
      await rm(paths.prefix, { recursive: true, force: true });
    }
  }
}

if (process.argv[2])
  void worker(process.argv[2]).catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });

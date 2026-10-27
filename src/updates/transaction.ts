import { npmPackageName } from '../shared/package.js';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UpdateRun } from '../shared/updates.js';

export interface TransactionPaths {
  root: string;
  prefix: string;
  candidate: string;
  previous: string;
  backup: string;
  dataDir: string;
  config: string;
}
export interface UpdateEffects {
  waitForIdle(): Promise<void>;
  backup(): Promise<void>;
  restore(): Promise<void>;
  stop(): Promise<void>;
  start(candidate: boolean): Promise<void>;
  verify(): Promise<void>;
  commit(): Promise<void>;
  hasCommitted?(): Promise<boolean>;
  resume?(): Promise<void>;
  phase(phase: UpdateRun['phase'], message: string): Promise<void>;
  switchLaunch?(): Promise<void>;
  restoreLaunch?(): Promise<void>;
}
/** Rollback is confined to admission: no new business writes are accepted before commit. */
export async function activateUpdate(
  paths: TransactionPaths,
  effects: UpdateEffects,
  reuseTarget = false,
) {
  let stopped = false;
  let moved = false;
  let backedUp = false;
  let committed = false;
  try {
    await effects.phase('waiting', '候选包已准备好，等待所有任务、审批与待核对操作结束');
    await effects.waitForIdle();
    await effects.phase('stopping', '已关闭新任务入口，正在停止旧服务并备份数据');
    // stop may fail after the process has already exited; recovery must restart the old service.
    stopped = true;
    await effects.stop();
    await effects.backup();
    backedUp = true;
    if (!reuseTarget) {
      await rename(paths.root, paths.previous);
      moved = true;
      await rename(paths.candidate, paths.root);
    }
    await effects.switchLaunch?.();
    await effects.phase('verifying', '正在启动新版、迁移数据库并验证；业务写入保持暂停');
    await effects.start(true);
    await effects.verify();
    await effects.commit();
    committed = true;
    // The new gateway persists the commit before admitting requests. Never restore its data later.
    return;
  } catch (error) {
    if (committed || (await effects.hasCommitted?.())) return;
    if (!stopped) {
      await effects.resume?.();
      await effects.phase('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    try {
      await effects.stop();
      if (moved) {
        await rm(paths.root, { recursive: true, force: true });
        await rename(paths.previous, paths.root);
      }
      if (backedUp) await effects.restore();
      await effects.restoreLaunch?.();
      await effects.phase(
        'rolledBack',
        `新版启动失败，已恢复旧版：${error instanceof Error ? error.message : String(error)}`,
      );
      await effects.start(false);
    } catch (recovery) {
      await effects.phase(
        'failed',
        `升级失败且恢复尚未完成；保留备份 ${paths.backup}。${String(error)}；恢复：${String(recovery)}`,
      );
      throw recovery;
    }
    throw error;
  }
}

export function transactionPaths(
  root: string,
  id: string,
  dataDir: string,
  config: string,
  backup: string,
): TransactionPaths {
  const prefix = join(dirname(root), `.covro-stage-${id}`);
  return {
    root,
    prefix,
    candidate: join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      npmPackageName,
    ),
    previous: join(dirname(root), `.covro-previous-${id}`),
    backup,
    dataDir,
    config,
  };
}

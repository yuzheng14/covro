import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { logContext } from '../logging/context.js';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { BackupController, BackupRecord, BackupStatus } from '../shared/backups.js';
import { AppError } from '../shared/errors.js';
import type { GatewayService } from '../server/service.js';
import { acquireMaintenanceLock } from './lock.js';
import { backupFailure, type BackupStore } from './store.js';

export const backupRequestSchema = z.object({ clientOperationId: z.string().uuid() }).strict();
const ongoing = (record: BackupRecord) =>
  ['waiting', 'copying', 'verifying'].includes(record.phase);

export class BackupManager implements BackupController {
  private active?: BackupRecord;
  private abort?: AbortController;
  private task?: Promise<void>;
  private closed = false;
  constructor(
    readonly store: BackupStore,
    private readonly service: GatewayService,
    private readonly options: {
      logger?: Logger;
      pollMs?: number;
      timeoutMs?: number;
      unsupportedReason?: string;
    } = {},
  ) {}
  async status(): Promise<BackupStatus> {
    const records = (await this.store.list()).map((record) =>
      this.active?.id === record.id
        ? this.active
        : ongoing(record)
          ? {
              ...record,
              phase: 'interrupted' as const,
              message: '备份进程已中断，未生成可恢复快照。',
            }
          : record,
    );
    return {
      directory: this.store.options.directory,
      schemaVersion: this.store.options.contract.schemaVersion,
      records,
      active: this.active,
      supported: !this.options.unsupportedReason,
      unsupportedReason: this.options.unsupportedReason,
    };
  }
  async start(input: { clientOperationId: string }) {
    const { clientOperationId: id } = backupRequestSchema.parse(input);
    if (this.closed) throw new AppError('BACKUP_UNAVAILABLE', '服务正在关闭。', 503);
    if (this.options.unsupportedReason)
      throw new AppError('BACKUP_UNAVAILABLE', this.options.unsupportedReason, 409);
    if (this.active?.id === id || (await this.store.list()).some((record) => record.id === id))
      return this.status();
    if (this.active) throw new AppError('BACKUP_BUSY', '已有备份正在处理。', 409);
    if (this.service.isInMaintenance()) throw this.service.maintenanceError();
    const release = await acquireMaintenanceLock(this.store.options.dataDir);
    if (this.closed) {
      await release();
      throw new AppError('BACKUP_UNAVAILABLE', '服务正在关闭。', 503);
    }
    const abort = new AbortController();
    const record: BackupRecord = {
      id,
      phase: 'waiting',
      trigger: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path: this.store.path(id),
      message: '等待任务、审批、输入及待核对操作结束',
    };
    this.active = record;
    this.abort = abort;
    const preparation = this.store.record(record);
    this.task = (async () => {
      try {
        await preparation;
      } catch (error) {
        (this.options.logger ?? nullLogger).warn('backup.preparation_failed', {
          backupId: id,
          ...errorFields(error),
        });
        await release();
        this.active = undefined;
        this.abort = undefined;
        return;
      }
      await this.run(record, abort, release);
    })();
    try {
      await preparation;
    } catch (error) {
      throw new AppError('BACKUP_FAILED', backupFailure(error), 500);
    }
    return this.status();
  }
  private async run(record: BackupRecord, abort: AbortController, release: () => Promise<void>) {
    const logger = (this.options.logger ?? nullLogger).child({
      ...logContext(),
      backupId: record.id,
      operationId: record.id,
    });
    logger.info('backup.started');
    let outcome = 'failed';
    let gated = false;
    try {
      for (;;) {
        abort.signal.throwIfAborted();
        if (Date.now() - record.createdAt > (this.options.timeoutMs ?? 30 * 60_000))
          throw new AppError('BACKUP_TIMEOUT', '等待安全点超时，请稍后重试。', 409);
        const result = this.service.prepareUpdate('backup');
        if (result.ready) {
          gated = true;
          break;
        }
        if (record.message !== result.reason) {
          record.message = result.reason ?? '等待任务结束';
          record.updatedAt = Date.now();
          await this.store.record(record);
        }
        await setTimeout(this.options.pollMs ?? 250, undefined, { signal: abort.signal });
      }
      await this.store.create({
        id: record.id,
        trigger: 'manual',
        reserved: true,
        signal: abort.signal,
        progress: (next) => {
          if (this.active?.phase !== next.phase)
            logger.info('backup.phase_changed', { stage: next.phase });
          this.active = next;
        },
      });
      outcome = 'succeeded';
    } catch (error) {
      outcome = abort.signal.aborted ? 'cancelled' : 'failed';
      logger.warn('backup.failed', { outcome, ...errorFields(error) });
      if (this.active?.phase !== 'failed' && this.active?.phase !== 'cancelled') {
        record.phase = abort.signal.aborted ? 'cancelled' : 'failed';
        record.message = abort.signal.aborted
          ? '备份已取消。'
          : error instanceof AppError
            ? error.message
            : backupFailure(error);
        record.updatedAt = Date.now();
        await this.store.record(record).catch(() => {});
      }
    } finally {
      logger.info('backup.finished', { outcome, durationMs: Date.now() - record.createdAt });
      if (gated) this.service.setMaintenance(false);
      await release();
      this.active = undefined;
      this.abort = undefined;
    }
  }
  async cancel(id: string) {
    if (this.active?.id === id) {
      this.abort?.abort();
      await this.task;
    }
    return this.status();
  }
  async verify(id: string) {
    if (this.active && !ongoing(this.active)) await this.task;
    if (this.active) throw new AppError('BACKUP_BUSY', '请等待当前备份完成。', 409);
    try {
      await this.store.verify(id);
      const record = (await this.store.list()).find((entry) => entry.id === id);
      if (record)
        await this.store.record({
          ...record,
          phase: 'succeeded',
          message: '备份已重新验证，完整性检查通过。',
          updatedAt: Date.now(),
        });
    } catch {
      const record = (await this.store.list()).find((entry) => entry.id === id);
      if (record)
        await this.store
          .record({
            ...record,
            phase: 'corrupt',
            message: '备份损坏、不完整或与当前版本不兼容，不能恢复。',
            updatedAt: Date.now(),
          })
          .catch(() => {});
      throw new AppError('BACKUP_INVALID', '备份损坏、不完整或与当前版本不兼容，不能恢复。', 409);
    }
    return this.status();
  }
  async close() {
    this.closed = true;
    this.abort?.abort();
    await this.task;
  }
}

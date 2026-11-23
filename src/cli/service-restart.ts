import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireMaintenanceLock } from '../backups/lock.js';
import { errorFields } from '../logging/fields.js';
import type { Logger } from '../logging/logger.js';
import { loadConfig, type AppConfig } from '../server/config.js';
import type { GatewayService } from '../server/service.js';
import { AppError } from '../shared/errors.js';
import {
  restartActive,
  restartRecoveryMs,
  type RestartBlocker,
  type RestartController,
  type RestartRequest,
  type RestartRun,
} from '../shared/service-restart.js';
import { readJson, saveJson } from '../updates/files.js';
import type { UpdateManager } from '../updates/manager.js';
import { verifyRuntimeExecutable } from '../updates/runtime.js';
import { acquireLifecycle } from './background.js';
import { restartFile } from './control.js';
import { packageInfo, packageRoot, type CovroPaths } from './paths.js';
import { runningRuntime } from './runtime.js';

const waitLimit = 30 * 60_000;
export const restartHandoffEnv = 'COVRO_INTERNAL_RESTART_ID';

interface RestartRecord {
  run: RestartRun;
  handoff?: { identity: string; epoch: string; pid: number };
}

async function instanceIdentity(config: AppConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        dataDir: await realpath(config.dataDir),
        host: config.host,
        port: config.port,
        origins: [...config.publicOrigin].sort(),
        auth: config.auth,
      }),
    )
    .digest('hex');
}

export class ServiceRestart implements RestartController {
  private record?: RestartRecord;
  private service?: GatewayService;
  private maintenanceBusy = false;
  private nativeBlockers: RestartBlocker[] = [];
  private stopped = false;
  committing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private mutations: Promise<unknown> = Promise.resolve();
  readonly supported =
    ['darwin', 'linux'].includes(process.platform) && typeof process.execve === 'function';

  constructor(
    private readonly location: CovroPaths,
    private readonly logger: Logger,
  ) {}

  async initialize(handoffId: string | undefined) {
    this.record = await readJson<RestartRecord>(restartFile(this.location));
    if (!restartActive(this.record?.run)) return;
    const { run, handoff } = this.record!;
    if (run.phase === 'restarting' && run.id === handoffId && handoff?.pid === process.pid)
      return handoff;
    await this.fail('interrupted');
  }

  async assertConfig(config: AppConfig, identity: string) {
    if ((await instanceIdentity(config)) !== identity)
      throw new AppError(
        'RESTART_IDENTITY',
        'The data directory, listener, or access settings changed',
        409,
      );
  }

  async attach(
    config: AppConfig,
    service: GatewayService,
    updates: UpdateManager,
    shutdown: () => Promise<void>,
    recoveredEpoch?: string,
  ) {
    this.service = service;
    const identity = await instanceIdentity(config);
    if (recoveredEpoch) {
      // The private control socket and HTTP listener already belong to the new daemon.
      await this.save({ run: { ...this.record!.run, phase: 'verifying' } });
    }
    const poll = async () => {
      const run = this.record?.run;
      if (this.stopped || !restartActive(run)) return;
      if (run!.phase === 'verifying') {
        const system = service.getSystem();
        if (system.ready && system.codexEpoch !== recoveredEpoch)
          await this.save({ run: { ...run!, phase: 'succeeded' } });
        else if (Date.now() >= run!.recoveryDeadline!) await this.fail('codex');
      } else if (run!.phase === 'waiting') {
        if (Date.now() > run!.createdAt + waitLimit) await this.fail('timedOut');
        else if (!service.restartBlockers().length)
          await this.tryRestart(config, identity, service, updates, shutdown);
      }
    };
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.serialize(poll)
          .catch((error: unknown) => this.logger.error('restart.poll_failed', errorFields(error)))
          .finally(schedule);
      }, 500);
      this.timer.unref();
    };
    schedule();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  status() {
    const localBlockers = this.stopped ? [] : (this.service?.restartBlockers() ?? []);
    const blockers = [...new Set([...localBlockers, ...this.nativeBlockers])];
    if (this.maintenanceBusy && !blockers.includes('maintenance')) blockers.push('maintenance');
    return { supported: this.supported, run: this.record?.run, blockers };
  }

  start(input: RestartRequest) {
    return this.serialize(async () => {
      if (this.stopped) throw new AppError('GATEWAY_STOPPING', 'Covro is stopping', 503);
      const latest = this.record?.run;
      // The observed receipt fences requests delayed across cancellation or a completed restart.
      if (latest && (restartActive(latest) || input.afterId !== latest.id))
        return { restartId: latest.id };
      if (!latest && input.afterId !== null)
        throw new AppError(
          'RESTART_CHANGED',
          'Restart status changed; reload it and try again',
          409,
        );
      await this.save({
        run: { id: input.clientOperationId, phase: 'waiting', createdAt: Date.now() },
      });
      return { restartId: input.clientOperationId };
    });
  }

  cancel(id: string) {
    return this.serialize(async () => {
      const run = this.record?.run;
      if (run?.id === id && run.phase === 'waiting')
        await this.save({ run: { ...run, phase: 'cancelled' } });
      return this.status();
    });
  }

  async fail(failure: NonNullable<RestartRun['failure']>, error?: unknown) {
    const run = this.record?.run;
    if (!run) return;
    this.logger.warn('restart.failed', {
      operationId: run.id,
      stage: failure,
      ...errorFields(error),
    });
    await this.save({ run: { ...run, phase: 'failed', failure } });
  }

  private async tryRestart(
    config: AppConfig,
    identity: string,
    service: GatewayService,
    updates: UpdateManager,
    shutdown: () => Promise<void>,
  ) {
    const releases: (() => Promise<void>)[] = [];
    let gated = false;
    let phase: NonNullable<RestartRun['failure']> = 'launch';
    let id: string | undefined;
    try {
      try {
        const releaseUpdate = await updates.reserveServiceRestart();
        if (releaseUpdate) releases.push(releaseUpdate);
        releases.push(await acquireMaintenanceLock(config.dataDir));
        releases.push(await acquireLifecycle(this.location, false));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ELOCKED' &&
          !(error instanceof AppError && error.code === 'MAINTENANCE_BUSY')
        )
          throw error;
        this.maintenanceBusy = true;
        return;
      }
      this.maintenanceBusy = false;
      const runtime = runningRuntime();
      await access(runtime.entry, constants.R_OK);
      await verifyRuntimeExecutable(runtime);
      const installed = await readJson<typeof packageInfo>(join(packageRoot, 'package.json'));
      if (installed?.name !== packageInfo.name || installed.version !== packageInfo.version)
        throw new Error('Covro package on disk changed');
      phase = 'config';
      const next = await loadConfig({ configPath: this.location.config, development: false });
      phase = 'identity';
      await this.assertConfig(next, identity);
      phase = 'activity';
      this.nativeBlockers = await service.nativeRestartBlockers();

      if (this.nativeBlockers.length) return;
      if (this.stopped || service.restartBlockers(true).length) return;
      gated = true;
      this.committing = true;
      phase = 'storage';
      const run = this.record!.run;
      const handoff = { identity, epoch: service.getSystem().codexEpoch, pid: process.pid };
      await this.save({
        run: { ...run, phase: 'restarting', recoveryDeadline: Date.now() + restartRecoveryMs },
        handoff,
      });
      if (this.stopped) {
        await this.fail('interrupted');
        return;
      }
      phase = 'shutdown';
      this.close();
      await shutdown();
      id = run.id;
    } catch (error) {
      await this.fail(phase, error);
    } finally {
      for (const release of releases.reverse()) {
        await release().catch((error: unknown) =>
          this.logger.warn('restart.lock_release_failed', errorFields(error)),
        );
      }
      if (!this.stopped) {
        this.committing = false;
        if (gated) service.setMaintenance(false, 'restart');
      }
    }
    if (!id) {
      if (this.stopped && gated) process.exitCode = 1;
      return;
    }
    try {
      // The same launchd/systemd job or foreground process retains its PID, cwd, and environment.
      process.execve!(
        process.execPath,
        [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        {
          ...process.env,
          [restartHandoffEnv]: id,
        },
      );
    } catch (error) {
      console.error('Covro could not reload its process; check covro status and covro logs.');
      await this.fail('launch', error);
      process.exitCode = 1;
    }
  }

  private async save(record: RestartRecord) {
    await saveJson(restartFile(this.location), record);
    this.record = record;
    if (record.run.phase !== 'waiting') {
      this.maintenanceBusy = false;
      this.nativeBlockers = [];
      this.logger.info('restart.phase_changed', {
        operationId: record.run.id,
        stage: record.run.phase,
      });
    }
  }

  private serialize<T>(work: () => Promise<T>) {
    const result = this.mutations.then(work);
    this.mutations = result.catch(() => {});
    return result;
  }
}

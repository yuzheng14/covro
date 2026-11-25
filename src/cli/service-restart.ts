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
import { confirmRestart, restartService } from '../updates/service-restart.js';
import { acquireLifecycle } from './background.js';
import { restartFile } from './control.js';
import { packageInfo, packageRoot, type CovroPaths } from './paths.js';
import { runningRuntime } from './runtime.js';

const waitLimit = 30 * 60_000;
export const restartHandoffEnv = 'COVRO_INTERNAL_RESTART_ID';

type Handoff = { identity: string; epoch: string; pid: number };
type RestartFailure = NonNullable<RestartRun['failure']>;
interface RestartRecord {
  run: RestartRun;
  handoff?: Handoff;
}
interface RestartContext {
  config: AppConfig;
  identity: string;
  service: GatewayService;
  updates: UpdateManager;
  shutdown: () => Promise<void>;
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
  private context?: RestartContext;
  private controller?: AbortController;
  private blockers: RestartBlocker[] = [];
  private closed = false;
  committing = false;
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
    this.context = { config, identity: await instanceIdentity(config), service, updates, shutdown };
    const run = this.record?.run;
    if (run && recoveredEpoch) {
      await this.save({ ...run, phase: 'verifying' });
      const signal = (this.controller = new AbortController()).signal;
      this.background(
        confirmRestart(
          async () => {
            const system = service.getSystem();
            return system.ready && system.codexEpoch !== recoveredEpoch;
          },
          () => this.save({ ...run, phase: 'succeeded' }),
          { interval: 500, deadline: run.recoveryDeadline, signal },
        ).catch((error: unknown) => {
          if (!signal.aborted) return this.fail('codex', error);
        }),
      );
    } else if (run?.phase === 'waiting') this.launch(run);
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }

  isPending(): boolean {
    return restartActive(this.record?.run);
  }

  status() {
    const local = this.closed ? [] : (this.context?.service.restartBlockers() ?? []);
    return {
      supported: this.supported,
      run: this.record?.run,
      blockers: [...new Set([...local, ...this.blockers])],
    };
  }

  start(input: RestartRequest) {
    return this.serialize(async () => {
      if (this.closed) throw new AppError('GATEWAY_STOPPING', 'Covro is stopping', 503);
      const latest = this.record?.run;
      // The observed receipt fences requests delayed across cancellation or a completed restart.
      if (latest && (this.committing || restartActive(latest) || input.afterId !== latest.id))
        return { restartId: latest.id };
      if (!latest && input.afterId !== null)
        throw new AppError(
          'RESTART_CHANGED',
          'Restart status changed; reload it and try again',
          409,
        );
      const run: RestartRun = {
        id: input.clientOperationId,
        phase: 'waiting',
        createdAt: Date.now(),
      };
      await this.save(run);
      this.launch(run);
      return { restartId: run.id };
    });
  }

  cancel(id: string) {
    return this.serialize(async () => {
      const run = this.record?.run;
      if (run?.id === id && run.phase === 'waiting' && !this.committing) {
        await this.save({ ...run, phase: 'cancelled' });
        this.controller?.abort();
      }
      return this.status();
    });
  }

  async fail(failure: RestartFailure, error?: unknown) {
    const run = this.record?.run;
    if (!run) return;
    this.logger.warn('restart.failed', {
      operationId: run.id,
      stage: failure,
      ...errorFields(error),
    });
    await this.save({ ...run, phase: 'failed', failure });
  }

  private launch(run: RestartRun) {
    if (!this.context) return;
    const signal = (this.controller = new AbortController()).signal;
    this.background(this.perform(run, this.context, signal));
  }

  private background(task: Promise<void>) {
    void task.catch((error: unknown) =>
      this.logger.error('restart.record_failed', errorFields(error)),
    );
  }

  private async perform(
    run: RestartRun,
    { config, identity, service, updates, shutdown }: RestartContext,
    signal: AbortSignal,
  ) {
    const releases: (() => Promise<void>)[] = [];
    const release = async () => {
      for (const unlock of releases.splice(0).reverse())
        await unlock().catch((error: unknown) =>
          this.logger.warn('restart.lock_release_failed', errorFields(error)),
        );
    };
    let stage: RestartFailure = 'launch';
    let stopped = false;
    let gated = false;
    const prepare = async () => {
      signal.throwIfAborted();
      if (service.restartBlockers().length) return false;
      stage = 'launch';
      try {
        const updateLock = await updates.reserveServiceRestart();
        if (updateLock) releases.push(updateLock);
        releases.push(await acquireMaintenanceLock(config.dataDir));
        releases.push(await acquireLifecycle(this.location, false));
        this.blockers = [];
        const runtime = runningRuntime();
        await access(runtime.entry, constants.R_OK);
        await verifyRuntimeExecutable(runtime);
        const installed = await readJson<typeof packageInfo>(join(packageRoot, 'package.json'));
        if (installed?.name !== packageInfo.name || installed.version !== packageInfo.version)
          throw new Error('Covro package on disk changed');
        stage = 'config';
        const next = await loadConfig({ configPath: this.location.config, development: false });
        stage = 'identity';
        await this.assertConfig(next, identity);
        stage = 'activity';
        this.blockers = await service.nativeRestartBlockers();
        signal.throwIfAborted();
        gated = !this.blockers.length && !service.restartBlockers(true).length;
        this.committing = gated;
        return gated;
      } catch (error) {
        if (
          stage !== 'launch' ||
          !['ELOCKED', 'MAINTENANCE_BUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        this.blockers = ['maintenance'];
        return false;
      } finally {
        if (!gated) await release();
      }
    };
    try {
      await restartService(
        {
          prepare: () => this.serialize(prepare),
          stop: async () => {
            stage = 'storage';
            await this.save(
              { ...run, phase: 'restarting', recoveryDeadline: Date.now() + restartRecoveryMs },
              { identity, epoch: service.getSystem().codexEpoch, pid: process.pid },
            );
            stage = 'interrupted';
            signal.throwIfAborted();
            stage = 'shutdown';
            stopped = true;
            await shutdown();
          },
          start: async () => {
            await release();
            stage = 'launch';
            // Replace the image under the same foreground process or service manager.
            process.execve!(
              process.execPath,
              [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
              { ...process.env, [restartHandoffEnv]: run.id },
            );
          },
        },
        {
          interval: 500,
          deadline: run.createdAt + waitLimit,
          signal,
          timeout: () => new AppError('RESTART_WAIT_TIMEOUT', 'Covro did not become idle'),
        },
      );
    } catch (error) {
      await this.serialize(async () => {
        if (signal.aborted && !gated) return;
        if (stopped) process.exitCode = 1;
        const timedOut = error instanceof AppError && error.code === 'RESTART_WAIT_TIMEOUT';
        await this.fail(timedOut ? 'timedOut' : stage, error);
      });
    } finally {
      await release();
      if (gated) {
        if (!this.closed) service.setMaintenance(false, 'restart');
        this.committing = false;
      }
    }
  }

  private async save(run: RestartRun, handoff?: Handoff) {
    const record = { run, handoff };
    await saveJson(restartFile(this.location), record);
    this.record = record;
    if (run.phase !== 'waiting') {
      this.blockers = [];
      this.logger.info('restart.phase_changed', { operationId: run.id, stage: run.phase });
    }
  }

  private serialize<T>(work: () => Promise<T>) {
    const result = this.mutations.then(work);
    this.mutations = result.catch(() => {});
    return result;
  }
}

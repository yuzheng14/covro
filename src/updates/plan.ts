import type { UpdateRun, UpdateStatus } from '../shared/updates.js';
import { compareVersions } from './registry.js';

export interface AutomaticPlanEffects {
  status(fresh: boolean): Promise<UpdateStatus>;
  readiness(): Promise<{ ready: boolean; reason?: string }>;
  save(run: UpdateRun): Promise<void>;
  freeze(checkedAt: number): Promise<{ ready: boolean; run?: UpdateRun }>;
  pause(): Promise<void>;
}

/** The worker owns the mutable plan; the daemon serializes its final freeze with user changes. */
export async function waitForAutomaticPlan(run: UpdateRun, effects: AutomaticPlanEffects) {
  const refresh = async (fresh: boolean) => {
    const status = await effects.status(fresh);
    const candidate = status.available;
    if (candidate) {
      run = {
        ...run,
        target: candidate.version,
        commit: candidate.commit,
        sourceChannel: candidate.channel,
        candidate,
        codex:
          candidate.codex.manifest && candidate.codex.version
            ? {
                version: candidate.codex.version,
                manifest: candidate.codex.manifest,
                confirmedUnverified: false,
              }
            : undefined,
        runtime:
          status.runtime?.target && run.runtime
            ? {
                from: run.runtime.from,
                target: status.runtime.target,
              }
            : undefined,
      };
    }
    run = { ...run, updatedAt: Date.now() };
    await effects.save(run);
    if (status.checkError || status.runtime?.error)
      throw new Error(status.checkError ?? status.runtime?.error);
    if (
      !candidate ||
      !status.runtime?.target ||
      candidate.requestedChannel !== run.channel ||
      !candidate.commit ||
      candidate.codex.status !== 'verified' ||
      candidate.downgrade ||
      compareVersions(candidate.version, run.from) <= 0
    )
      throw new Error(candidate?.codex.reason ?? '自动升级目标或兼容性无法确认，请重新检查更新');
    return status;
  };
  for (;;) {
    await refresh(false);
    const idle = await effects.readiness();
    if (idle.ready) {
      // This includes runtime and Codex checks. Tasks can become busy again during the probes.
      const checked = await refresh(true);
      const frozen = await effects.freeze(checked.checkedAt!);
      if (frozen.ready && frozen.run) return frozen.run;
    } else {
      run = { ...run, message: idle.reason ?? '等待所有任务结束', updatedAt: Date.now() };
      await effects.save(run);
    }
    await effects.pause();
  }
}

/** A failed control response may still have durably frozen the transaction. */
export async function confirmAutomaticFreeze(
  id: string,
  freeze: () => Promise<{ ready: boolean; run?: UpdateRun }>,
  readRun: () => Promise<UpdateRun | undefined>,
) {
  try {
    return await freeze();
  } catch (error) {
    const durable = await readRun();
    if (durable?.id === id && durable.transactionStartedAt) return { ready: true, run: durable };
    throw error;
  }
}

import { expect, it, vi } from 'vitest';
import {
  waitForAutomaticPlan,
  confirmAutomaticFreeze,
  type AutomaticPlanEffects,
} from '../../src/updates/plan.js';
import { assessCodexCompatibility } from '../../src/shared/codex-compatibility.js';
import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { runningRuntime } from '../../src/cli/runtime.js';
import type { UpdateRun, UpdateStatus } from '../../src/shared/updates.js';

function fixture() {
  const state: UpdateStatus = {
    version: '0.8.1-dev.2',
    source: 'npm',
    supported: true,
    settings: { channel: 'dev', automatic: true },
    checkedAt: 123,
    codex: assessCodexCompatibility(CODEX_COMPATIBILITY, CODEX_COMPATIBILITY.recommended),
    runtime: { current: runningRuntime(), target: runningRuntime(), migration: false },
  };
  const candidate = (version: string, metadata: unknown = CODEX_COMPATIBILITY) => {
    state.available = {
      version,
      requestedChannel: 'dev',
      channel: 'dev',
      commit: `commit-${version}`,
      downgrade: false,
      codex: assessCodexCompatibility(metadata, state.codex.version),
    };
  };
  candidate('0.8.1-dev.3');
  let saved: UpdateRun = {
    id: crypto.randomUUID(),
    from: state.version,
    target: '0.8.1-dev.3',
    channel: 'dev',
    automatic: { revision: 'test' },
    phase: 'waiting',
    message: '',
    startedAt: 1,
    updatedAt: 1,
    runtime: { from: runningRuntime(), target: runningRuntime() },
  };
  const history: UpdateRun[] = [];
  const effects: AutomaticPlanEffects = {
    status: vi.fn(async () => structuredClone(state)),
    readiness: vi.fn(async () => ({ ready: true })),
    save: vi.fn(async (run) => {
      saved = structuredClone(run);
      history.push(saved);
    }),
    freeze: vi.fn(async () => ({
      ready: true,
      run: { ...saved, phase: 'installing' as const, transactionStartedAt: 5 },
    })),
    pause: vi.fn(async () => {}),
  };
  return { state, candidate, run: saved, effects, history };
}

it('coalesces successive releases, rechecks when idle and waits again if tasks become busy during probing', async () => {
  const f = fixture();
  vi.mocked(f.effects.readiness).mockResolvedValueOnce({ ready: false });
  vi.mocked(f.effects.pause).mockImplementationOnce(async () => {
    f.candidate('0.8.1-dev.4');
  });
  vi.mocked(f.effects.freeze).mockResolvedValueOnce({ ready: false });
  vi.mocked(f.effects.pause).mockImplementationOnce(async () => {
    f.candidate('0.8.1-dev.5');
  });
  const frozen = await waitForAutomaticPlan(f.run, f.effects);
  expect(frozen).toMatchObject({
    id: f.run.id,
    target: '0.8.1-dev.5',
    commit: 'commit-0.8.1-dev.5',
  });
  expect(f.effects.freeze).toHaveBeenCalledTimes(2);
  expect(f.effects.status).toHaveBeenCalledWith(true);
  expect(new Set(f.history.map((run) => run.id)).size).toBe(1);
  expect(f.history.map((run) => run.target)).toContain('0.8.1-dev.4');
});

it.each([
  'unverified',
  'unsupported',
  'unknown',
  'network',
  'runtime',
  'commit',
  'downgrade',
] as const)('blocks %s without falling back to the previously verified target', async (mode) => {
  const f = fixture();
  if (mode === 'network') {
    f.state.checkError = 'probe failed';
    f.state.available = undefined;
  } else if (mode === 'runtime') f.state.runtime!.error = 'runtime failed';
  else {
    f.candidate(
      '0.8.1-dev.4',
      mode === 'unverified' || mode === 'unsupported'
        ? {
            recommended: '99.0.0',
            verified: ['99.0.0'],
            unsupported:
              mode === 'unsupported'
                ? [{ version: CODEX_COMPATIBILITY.recommended, reason: 'fixture' }]
                : [],
          }
        : CODEX_COMPATIBILITY,
    );
    if (mode === 'unknown')
      f.state.available!.codex = assessCodexCompatibility(undefined, f.state.codex.version);
    if (mode === 'commit') delete f.state.available!.commit;
    if (mode === 'downgrade') f.state.available!.downgrade = true;
  }
  await expect(waitForAutomaticPlan(f.run, f.effects)).rejects.toThrow();
  expect(f.effects.freeze).not.toHaveBeenCalled();
});

it('does not freeze after an idle refresh fails or its result is unknown', async () => {
  const f = fixture();
  vi.mocked(f.effects.status).mockRejectedValueOnce(new Error('control response unknown'));
  await expect(waitForAutomaticPlan(f.run, f.effects)).rejects.toThrow('unknown');
  expect(f.effects.freeze).not.toHaveBeenCalled();
});

it('recovers the pinned identity after a lost freeze response, and refuses unknown unfrozen results', async () => {
  const f = fixture();
  const lost = async () => {
    throw new Error('response lost');
  };
  const frozen: UpdateRun = { ...f.run, transactionStartedAt: 123, phase: 'installing' };
  expect(await confirmAutomaticFreeze(f.run.id, lost, async () => frozen)).toEqual({
    ready: true,
    run: frozen,
  });
  await expect(confirmAutomaticFreeze(f.run.id, lost, async () => f.run)).rejects.toThrow(
    'response lost',
  );
  await expect(
    confirmAutomaticFreeze(f.run.id, lost, async () => ({ ...frozen, id: 'another-plan' })),
  ).rejects.toThrow('response lost');
});

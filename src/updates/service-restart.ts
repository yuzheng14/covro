import { setTimeout } from 'node:timers/promises';

interface WaitOptions {
  interval: number;
  signal?: AbortSignal;
  deadline?: number;
  timeout?: () => Error;
}

async function waitFor(
  probe: () => Promise<boolean>,
  { interval, signal, deadline = Infinity, timeout }: WaitOptions,
) {
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout?.() ?? new Error('Covro service readiness timed out');
    const ready = await probe();
    signal?.throwIfAborted();
    if (ready) return;
    await setTimeout(Math.min(interval, remaining), undefined, { signal });
  }
}

/** Preparation closes admission only after an atomic final idle check. */
export async function restartService(
  effects: {
    prepare(): Promise<boolean>;
    stop(): Promise<void>;
    start(): Promise<void>;
    confirm?(): Promise<void>;
  },
  wait: WaitOptions,
) {
  await waitFor(effects.prepare, wait);
  await effects.stop();
  await effects.start();
  await effects.confirm?.();
}

/** In-place launches resume here in the new daemon image. */
export async function confirmRestart(
  probe: () => Promise<boolean>,
  record: () => Promise<void>,
  wait: WaitOptions,
) {
  await waitFor(probe, wait);
  await record();
}

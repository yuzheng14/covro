import { randomUUID } from 'node:crypto';
import type { CodexEvent } from '../codex/types.js';
import type { CapacityRetryView, Settings, TurnView } from '../shared/types.js';
import { isModelCapacityError } from '../shared/turn-errors.js';

const DELAYS = [5_000, 10_000, 20_000] as const;
export interface CapacityAttempt {
  threadId: string;
  operationId: string;
  previousOperationId?: string;
  boundOperationId?: string;
  epoch: string;
  settings: Settings;
  turnId?: string;
  rootTurnId?: string;
  attempt: number;
  progressed: boolean;
  nativeRetry: boolean;
  cancelled: boolean;
  interruptSent?: boolean;
  error?: { message: string; code?: string };
  handled: Set<string>;
  view?: CapacityRetryView;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns only retries which Codex declined to perform. No prompt or attachment is replayed. */
export class CapacityRetries {
  private readonly jobs = new Map<string, CapacityAttempt>();
  constructor(
    private readonly run: (job: CapacityAttempt) => Promise<void>,
    private readonly changed: (threadId: string) => void,
  ) {}

  begin(threadId: string, operationId: string, settings: Settings, epoch: string) {
    this.clear(threadId);
    const job: CapacityAttempt = {
      threadId,
      operationId,
      settings: structuredClone(settings),
      epoch,
      attempt: 0,
      progressed: false,
      nativeRetry: false,
      cancelled: false,
      handled: new Set(),
    };
    this.jobs.set(threadId, job);
    return job;
  }

  current(threadId: string) {
    return this.jobs.get(threadId);
  }
  owns(job: CapacityAttempt) {
    return this.current(job.threadId) === job && !job.cancelled;
  }
  view(threadId: string) {
    return this.current(threadId)?.view;
  }
  pending(threadId: string) {
    return ['waiting', 'retrying'].includes(this.view(threadId)?.status ?? '');
  }
  active() {
    return [...this.jobs.keys()].some((id) => this.pending(id));
  }

  clear(threadId: string) {
    const job = this.current(threadId);
    if (job?.timer) clearTimeout(job.timer);
    if (job) job.cancelled = true;
    this.jobs.delete(threadId);
  }
  clearAll() {
    for (const id of this.jobs.keys()) this.clear(id);
  }

  cancel(job: CapacityAttempt) {
    if (job.timer) clearTimeout(job.timer);
    delete job.timer;
    job.cancelled = true;
    if (job.view) job.view = { ...job.view, status: 'cancelled', nextAttemptAt: undefined };
    this.changed(job.threadId);
  }

  observe(event: CodexEvent, operationId?: string) {
    const threadId =
      event.type === 'action'
        ? event.action.threadId
        : 'threadId' in event
          ? event.threadId
          : undefined;
    if (!threadId) return;
    const job = this.current(threadId);
    if (!job || job.cancelled) return;
    if (event.type === 'turn') {
      if (operationId === job.operationId && job.boundOperationId !== operationId) {
        job.boundOperationId = operationId;
        job.turnId = event.turn.id;
        job.rootTurnId ??= event.turn.id;
        if (job.view) job.view.turnId = event.turn.id;
      }
      if (event.turn.id !== job.turnId) {
        // A new turn from another client supersedes the original request.
        if (event.turn.status === 'running') this.clear(threadId);
        return;
      }
      if (event.turn.items.some((item) => item.type !== 'userMessage')) job.progressed = true;
      if (['completed', 'failed', 'interrupted'].includes(event.turn.status))
        this.finished(job, event.turn);
      return;
    }
    if (event.type === 'action') {
      if (!event.action.turnId || event.action.turnId === job.turnId) {
        job.progressed = true;
        if (job.timer) this.stop(job, 'progress');
      }
      return;
    }
    if (!('turnId' in event) || event.turnId !== job.turnId) return;
    if (event.type === 'turnError') {
      if (event.willRetry) {
        job.nativeRetry = true;
        if (job.timer) this.stop(job, 'native');
      } else {
        job.error = { message: event.message, code: event.errorCode };
        if (job.timer && !isModelCapacityError(event.message, event.errorCode))
          this.stop(job, 'error');
      }
    } else if (
      event.type === 'turnProgress' ||
      event.type === 'delta' ||
      event.type === 'diff' ||
      event.type === 'autoReview' ||
      event.type === 'compactionCompleted' ||
      (event.type === 'item' && event.item.type !== 'userMessage')
    ) {
      job.progressed = true;
      // Unexpected late progress invalidates a waiting retry rather than racing it.
      if (job.timer) this.stop(job, 'progress');
    }
  }

  private finished(job: CapacityAttempt, turn: TurnView) {
    if (turn.status !== 'failed') {
      this.clear(job.threadId);
      return;
    }
    if (job.handled.has(turn.id)) return;
    job.handled.add(turn.id);
    const message = turn.error ?? job.error?.message ?? '';
    const code = turn.errorCode ?? job.error?.code;
    if (!isModelCapacityError(message, code)) {
      if (job.view) this.stop(job, 'error');
      else this.clear(job.threadId);
      return;
    }
    job.view ??= {
      rootTurnId: job.rootTurnId!,
      turnId: turn.id,
      status: 'waiting',
      attempt: job.attempt,
      limit: DELAYS.length,
    };
    if (job.progressed || job.nativeRetry) {
      this.stop(job, job.progressed ? 'progress' : 'native');
      return;
    }
    const delay = DELAYS[job.attempt];
    if (delay === undefined) {
      this.stop(job, 'limit');
      return;
    }
    job.view = {
      ...job.view,
      status: 'waiting',
      attempt: job.attempt + 1,
      nextAttemptAt: Date.now() + delay,
    };
    job.timer = setTimeout(() => {
      delete job.timer;
      if (!this.owns(job)) return;
      job.attempt++;
      job.previousOperationId = job.operationId;
      job.operationId = randomUUID();
      job.error = undefined;
      job.view = {
        ...job.view!,
        status: 'retrying',
        attempt: job.attempt,
        nextAttemptAt: undefined,
      };
      this.changed(job.threadId);
      void this.run(job).catch(() => {
        // A failed or uncertain dispatch is never an invitation to replay the RPC.
        if (this.owns(job)) {
          this.stop(job, 'error');
        }
      });
    }, delay);
    job.timer.unref?.();
  }

  dispatchFailed(threadId: string, operationId: string) {
    const job = this.current(threadId);
    if (!job || job.operationId !== operationId || job.cancelled) return;
    if (job.view) this.stop(job, 'error');
    else this.clear(threadId);
  }

  private stop(job: CapacityAttempt, reason: NonNullable<CapacityRetryView['reason']>) {
    if (job.timer) clearTimeout(job.timer);
    delete job.timer;
    if (job.view) job.view = { ...job.view, status: 'stopped', reason, nextAttemptAt: undefined };
    this.changed(job.threadId);
  }
}

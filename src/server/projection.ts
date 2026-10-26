import { endCompactions, mergeCompaction, settleCompactions } from './compaction.js';
import type {
  AutoReviewView,
  ItemView,
  PendingAction,
  RunStatus,
  ThreadView,
  TurnView,
  TurnErrorMetadata,
} from '../shared/types.js';

export const isActive = (status: RunStatus): boolean =>
  status === 'running' || status === 'waitingApproval' || status === 'waitingInput';
export const isTerminal = (status: RunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'interrupted';

export class Projection {
  private readonly threads = new Map<string, ThreadView>();
  readonly actions = new Map<string, PendingAction>();
  private readonly revisions = new Map<string, number>();
  // Notifications may precede thread/turn history. Keep only a bounded, per-thread inbox.
  private readonly earlyAutoReviews = new Map<
    string,
    { threadId: string; turnId: string; item: ItemView; bytes: number }
  >();
  private earlyAutoReviewBytes = 0;
  constructor(private readonly maxItemBytes = 2 * 1024 * 1024) {}

  get(threadId: string): ThreadView | undefined {
    return this.threads.get(threadId);
  }
  values(): ThreadView[] {
    return [...this.threads.values()];
  }
  revision(threadId: string): number {
    return this.revisions.get(threadId) ?? 0;
  }
  touch(threadId: string): void {
    this.revisions.set(threadId, this.revision(threadId) + 1);
  }

  thread(
    incoming: ThreadView,
    preserveCurrent = false,
    preserveRuntimeSettings = preserveCurrent,
  ): ThreadView {
    const current = this.threads.get(incoming.id);
    if (!current) {
      const thread = structuredClone(incoming);
      for (const turn of thread.turns) turn.items = turn.items.map((item) => this.limit(item));
      thread.actions = [...this.actions.values()].filter((action) => action.threadId === thread.id);
      this.threads.set(thread.id, thread);
      for (const turn of thread.turns) {
        this.flushAutoReviews(thread.id, turn.id);
        this.finishReconnect(turn);
        settleCompactions(turn);
        if (isTerminal(turn.status)) this.finishAutoReviews(turn);
      }
    } else {
      const oldTurns = current.turns;
      const oldStatus = current.status;
      const oldRuntimeSettings = current.runtimeSettings;
      const oldTitle = current.title;
      Object.assign(current, incoming, { turns: oldTurns, actions: current.actions });
      if (oldRuntimeSettings && incoming.runtimeSettings)
        current.runtimeSettings = { ...oldRuntimeSettings, ...incoming.runtimeSettings };
      if (preserveCurrent) {
        current.status = oldStatus;
        current.title = oldTitle;
      }
      if (preserveRuntimeSettings) current.runtimeSettings = oldRuntimeSettings;
      for (const turn of incoming.turns) this.turn(incoming.id, turn, preserveCurrent);
    }
    this.touch(incoming.id);
    return this.threads.get(incoming.id)!;
  }

  turn(threadId: string, incoming: TurnView, preserveCurrent = false): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.hasMessages = true;
    const current = thread.turns.find((turn) => turn.id === incoming.id);
    if (!current)
      thread.turns.push({
        ...structuredClone(incoming),
        items: incoming.items.map((item) => this.limit(item)),
      });
    else {
      const items = current.items;
      if (!preserveCurrent) Object.assign(current, incoming, { items });
      for (const item of incoming.items) this.item(threadId, incoming.id, item, preserveCurrent);
    }
    // Tool cancellation can finish after a new turn starts. Only the latest
    // turn owns the thread status; older events still update their own history.
    if (!preserveCurrent && thread.turns.at(-1)?.id === incoming.id)
      thread.status = incoming.status;
    this.flushAutoReviews(threadId, incoming.id);
    const updated = thread.turns.find((turn) => turn.id === incoming.id)!;
    this.finishReconnect(updated);
    settleCompactions(updated);
    if (isTerminal(updated.status)) this.finishAutoReviews(updated);
    this.touch(threadId);
  }

  turnError(
    threadId: string,
    turnId: string,
    message: string,
    willRetry: boolean,
    metadata: TurnErrorMetadata = {},
  ): boolean {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn || !isActive(turn.status)) return false;
    // Keep display-only diagnostics bounded, without changing the execution reservation.
    const detail = message.slice(0, 4096);
    const info = {
      ...(metadata.errorCode ? { errorCode: metadata.errorCode.slice(0, 100) } : {}),
      ...(metadata.errorDetails ? { errorDetails: metadata.errorDetails.slice(0, 4096) } : {}),
    };
    if (willRetry) turn.reconnect = { status: 'retrying', message: detail, ...info };
    else {
      turn.error = detail;
      Object.assign(turn, info);
      endCompactions(turn, 'failed', detail);
      if (turn.reconnect)
        turn.reconnect = { ...turn.reconnect, ...info, status: 'failed', message: detail };
    }
    this.touch(threadId);
    return true;
  }

  compactionCompleted(threadId: string, turnId: string): boolean {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn || !endCompactions(turn, 'completed')) return false;
    this.touch(threadId);
    return true;
  }

  endThreadCompactions(threadId: string): void {
    for (const turn of this.threads.get(threadId)?.turns ?? []) endCompactions(turn, 'unknown');
    this.touch(threadId);
  }

  turnProgress(threadId: string, turnId: string): boolean {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn || !isActive(turn.status) || turn.reconnect?.status !== 'retrying') return false;
    delete turn.reconnect;
    this.touch(threadId);
    return true;
  }

  private finishReconnect(turn: TurnView): void {
    if (!turn.reconnect || !isTerminal(turn.status)) return;
    if (turn.status === 'failed') {
      turn.reconnect = {
        ...turn.reconnect,
        status: 'failed',
        message: (turn.error ?? turn.reconnect.message).slice(0, 4096),
      };
    } else delete turn.reconnect;
  }

  autoReview(threadId: string, turnId: string, review: AutoReviewView): boolean {
    const item = this.limit({
      id: `auto-review:${review.reviewId}`,
      type: 'autoApprovalReview',
      status: review.status,
      autoReview: review,
    });
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (turn) return this.applyAutoReview(threadId, turn, item);
    const key = JSON.stringify([threadId, turnId, review.reviewId]);
    const current = this.earlyAutoReviews.get(key);
    if (current && !this.reviewCanReplace(current.item, item)) return false;
    const bytes = Buffer.byteLength(JSON.stringify({ threadId, turnId, item }));
    if (current) this.earlyAutoReviewBytes -= current.bytes;
    this.earlyAutoReviews.set(key, { threadId, turnId, item, bytes });
    this.earlyAutoReviewBytes += bytes;
    while (this.earlyAutoReviews.size > 128 || this.earlyAutoReviewBytes > 4 * 1024 * 1024) {
      const oldest = this.earlyAutoReviews.keys().next().value!;
      this.earlyAutoReviewBytes -= this.earlyAutoReviews.get(oldest)!.bytes;
      this.earlyAutoReviews.delete(oldest);
    }
    return false;
  }

  private reviewCanReplace(current: ItemView, incoming: ItemView): boolean {
    const previous = current.autoReview!;
    const next = incoming.autoReview!;
    if (previous.status !== 'inProgress' && next.status === 'inProgress') return false;
    if (
      previous.completedAtMs !== undefined &&
      (next.completedAtMs === undefined || previous.completedAtMs > next.completedAtMs)
    )
      return false;
    return JSON.stringify(current) !== JSON.stringify(incoming);
  }

  private applyAutoReview(threadId: string, turn: TurnView, item: ItemView): boolean {
    const index = turn.items.findIndex(
      (entry) =>
        entry.type === 'autoApprovalReview' &&
        entry.autoReview?.reviewId === item.autoReview!.reviewId,
    );
    // Check the original event before converting an unfinished late review to unknown.
    if (index >= 0 && !this.reviewCanReplace(turn.items[index]!, item)) return false;
    if (isTerminal(turn.status) && item.autoReview!.status === 'inProgress') {
      item.autoReview!.status = 'unknown';
      item.status = 'unknown';
    }
    if (index < 0) turn.items.push(item);
    else {
      turn.items[index] = item;
    }
    this.touch(threadId);
    return true;
  }

  private flushAutoReviews(threadId: string, turnId: string): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    for (const [key, entry] of this.earlyAutoReviews) {
      if (entry.threadId !== threadId || entry.turnId !== turnId) continue;
      this.earlyAutoReviews.delete(key);
      this.earlyAutoReviewBytes -= entry.bytes;
      this.applyAutoReview(threadId, turn, entry.item);
    }
  }

  private finishAutoReviews(turn: TurnView): void {
    for (const item of turn.items) {
      if (item.autoReview?.status !== 'inProgress') continue;
      item.autoReview.status = 'unknown';
      item.status = 'unknown';
    }
  }

  item(threadId: string, turnId: string, item: ItemView, preserveCurrent = false): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    const index = turn.items.findIndex((entry) => entry.id === item.id);
    if (index < 0) turn.items.push(this.limit(item));
    else if (!preserveCurrent)
      turn.items[index] = this.limit(mergeCompaction(item, turn.items[index]));
    settleCompactions(turn);
    this.touch(threadId);
  }

  delta(
    threadId: string,
    turnId: string,
    itemId: string,
    field: 'text' | 'output',
    delta: string,
    itemType?: string,
  ): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    let item = turn.items.find((entry) => entry.id === itemId);
    if (!item) {
      item = {
        id: itemId,
        type: itemType ?? (field === 'text' ? 'agentMessage' : 'commandExecution'),
      };
      turn.items.push(item);
    }
    if (item.truncated) return;
    item[field] = (item[field] ?? '') + delta;
    Object.assign(item, this.limit(item));
    this.touch(threadId);
  }

  diff(threadId: string, turnId: string, diff: string): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (turn) turn.diff = this.clip(diff).value;
    this.touch(threadId);
  }

  action(action: PendingAction): void {
    const owner = action.threadId
      ? this.threads.get(action.threadId)?.turns.find((turn) => turn.id === action.turnId)
      : undefined;
    if (owner && isTerminal(owner.status) && ['pending', 'responding'].includes(action.status))
      action = { ...action, status: 'expired' };
    this.actions.set(action.actionId, action);
    const thread = action.threadId ? this.threads.get(action.threadId) : undefined;
    if (thread) {
      thread.actions = [...this.actions.values()].filter((entry) => entry.threadId === thread.id);
      this.updateActionStatus(thread);
      this.touch(thread.id);
    }
  }

  resolveAction(actionId: string, status: PendingAction['status']): PendingAction | undefined {
    const action = this.actions.get(actionId);
    if (!action) return undefined;
    action.status = status;
    const thread = action.threadId ? this.threads.get(action.threadId) : undefined;
    if (thread) {
      this.updateActionStatus(thread);
      this.touch(thread.id);
    }
    return action;
  }

  expireTurn(threadId: string, turnId: string): void {
    for (const action of this.actions.values())
      if (
        action.threadId === threadId &&
        action.turnId === turnId &&
        (action.status === 'pending' || action.status === 'responding')
      )
        this.resolveAction(action.actionId, 'expired');
  }

  runtimeReset(): void {
    for (const action of this.actions.values())
      if (action.status === 'pending' || action.status === 'responding')
        this.resolveAction(action.actionId, 'expired');
    for (const thread of this.threads.values()) {
      thread.managed = false;
      delete thread.resumeError;
      if (thread.runtimeSettings) {
        const { model, reasoningEffort } = thread.runtimeSettings;
        thread.runtimeSettings = { model, reasoningEffort };
      }
      if (isActive(thread.status)) thread.status = 'unknown';
      for (const turn of thread.turns) {
        if (turn.reconnect?.status === 'retrying') delete turn.reconnect;
        if (isActive(turn.status)) turn.status = 'unknown';
        endCompactions(turn, 'unknown');
        this.finishAutoReviews(turn);
      }
      this.touch(thread.id);
    }
    for (const entry of this.earlyAutoReviews.values()) {
      if (entry.item.autoReview?.status === 'inProgress') {
        this.earlyAutoReviewBytes -= entry.bytes;
        entry.item.autoReview.status = 'unknown';
        entry.item.status = 'unknown';
        entry.bytes = Buffer.byteLength(
          JSON.stringify({ threadId: entry.threadId, turnId: entry.turnId, item: entry.item }),
        );
        this.earlyAutoReviewBytes += entry.bytes;
      }
    }
  }

  private updateActionStatus(thread: ThreadView): void {
    const active = thread.actions.filter(
      (action) =>
        action.blocking !== false &&
        (action.status === 'pending' || action.status === 'responding'),
    );
    const turn = [...thread.turns].reverse().find((entry) => isActive(entry.status));
    if (!turn) return;
    const status = active.some(
      (action) => action.kind === 'questions' || action.kind === 'elicitation',
    )
      ? 'waitingInput'
      : active.length > 0
        ? 'waitingApproval'
        : 'running';
    thread.status = status;
    turn.status = status;
  }

  private limit(item: ItemView): ItemView {
    const result = structuredClone(item);
    if (result.images) {
      let bytes = 0;
      result.imageCount ??= result.images.length;
      result.images = result.images.filter((image) => {
        bytes += Buffer.byteLength(image);
        return bytes <= this.maxItemBytes;
      });
    }
    for (const field of ['text', 'output', 'command'] as const) {
      const value = result[field];
      if (value) {
        const clipped = this.clip(value);
        result[field] = clipped.value;
        if (clipped.truncated) result.truncated = true;
      }
    }
    if (result.changes)
      result.changes = result.changes.map((change) => {
        const clipped = this.clip(change.diff);
        if (clipped.truncated) result.truncated = true;
        return { ...change, diff: clipped.value };
      });
    if (result.details !== undefined) {
      const clipped = this.clip(JSON.stringify(result.details));
      if (clipped.truncated) {
        result.details = clipped.value;
        result.truncated = true;
      }
    }
    if (result.autoReview) {
      for (const field of ['actionLabel', 'actionSummary', 'cwd', 'rationale'] as const) {
        const value = result.autoReview[field];
        if (value === undefined) continue;
        const clipped = this.clip(value);
        result.autoReview[field] = clipped.value;
        if (clipped.truncated) result.truncated = true;
      }
    }
    return result;
  }

  private clip(value: string): { value: string; truncated: boolean } {
    if (Buffer.byteLength(value) <= this.maxItemBytes) return { value, truncated: false };
    // Iterating code points avoids a half UTF-8 character at the truncation boundary.
    let kept = '';
    let bytes = 0;
    for (const point of value) {
      bytes += Buffer.byteLength(point);
      if (bytes > this.maxItemBytes) break;
      kept += point;
    }
    return { value: `${kept}\n[输出已截断]`, truncated: true };
  }
}

/** Collect a cumulative counter delta over a fully observed turn; `last` is only one response. */
export class TurnTokenUsage {
  private readonly threads = new Map<
    string,
    {
      total?: number;
      active?: { id: string; baseline?: number; tokens?: number; invalid: boolean };
    }
  >();

  clear(): void {
    this.threads.clear();
  }

  created(threadId: string): void {
    if (!this.threads.has(threadId)) this.threads.set(threadId, { total: 0 });
  }

  started(threadId: string, turnId: string): void {
    const state = this.threads.get(threadId) ?? {};
    if (state.active?.id === turnId) return;
    state.active = { id: turnId, baseline: state.total, invalid: false };
    this.threads.set(threadId, state);
  }

  updated(threadId: string, turnId: string, total: number): void {
    const state = this.threads.get(threadId) ?? {};
    const active = state.active;
    // A replay of another turn's usage must not become this turn's baseline or result.
    if (active && active.id !== turnId) return;
    if (!Number.isSafeInteger(total) || total < 0) {
      if (active) active.invalid = true;
      delete state.total;
    } else {
      if (active) {
        if (state.total !== undefined && total < state.total) active.invalid = true;
        if (active.baseline !== undefined) active.tokens = total - active.baseline;
      }
      state.total = total;
    }
    this.threads.set(threadId, state);
  }

  compacted(threadId: string, turnId: string): void {
    const active = this.threads.get(threadId)?.active;
    // Compaction can replace cumulative counters. Do not subtract across that reset.
    if (active?.id === turnId) active.invalid = true;
  }

  completed(threadId: string, turnId: string): number | undefined {
    const state = this.threads.get(threadId);
    if (state?.active?.id !== turnId) return undefined;
    const active = state.active;
    delete state.active;
    return active.invalid ? undefined : active.tokens;
  }
}

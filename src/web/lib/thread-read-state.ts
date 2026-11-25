export const COMPLETION_READ_PREFIX = 'codex-web.read-completion:';

export function completionReadKey(threadId: string, turnId: string) {
  return `${COMPLETION_READ_PREFIX}${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`;
}

/** Per-turn receipts prevent an older tab from overwriting a newer turn's read state. */
export class CompletionReads {
  private readonly memory = new Set<string>();

  constructor(
    private readonly storage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> =>
      localStorage,
  ) {}

  isRead(threadId: string, turnId: string): boolean {
    const key = completionReadKey(threadId, turnId);
    if (this.memory.has(key)) return true;
    try {
      return this.storage().getItem(key) === '1';
    } catch {
      return false;
    }
  }

  markRead(threadId: string, turnId: string): boolean {
    if (this.isRead(threadId, turnId)) return false;
    const key = completionReadKey(threadId, turnId);
    this.memory.add(key);
    try {
      this.storage().setItem(key, '1');
    } catch {
      // Reading still works for this page when browser storage is unavailable or full.
    }
    return true;
  }

  clear(threadId: string, turnId: string): void {
    const key = completionReadKey(threadId, turnId);
    this.memory.delete(key);
    try {
      this.storage().removeItem(key);
    } catch {
      // The server acknowledgement is authoritative even if browser storage is unavailable.
    }
  }

  invalidate(key: string | null) {
    if (key === null) this.memory.clear();
    else this.memory.delete(key);
  }
}

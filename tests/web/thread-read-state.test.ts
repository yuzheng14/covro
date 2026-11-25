import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from '../../src/shared/types';
import { completedTurnId } from '../../src/shared/thread-summary';
import { CompletionReads } from '../../src/web/lib/thread-read-state';

const completed: ThreadSummary = {
  id: 'thread',
  projectId: 'project',
  source: 'vscode',
  title: 'A result',
  status: 'idle',
  managed: true,
  pendingActionCount: 0,
  lastTurnId: 'turn-1',
  lastTurnStatus: 'completed',
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('completion read receipts', () => {
  it('uses the actual completed turn rather than title, timestamp or idle status alone', () => {
    expect(completedTurnId(completed)).toBe('turn-1');
    expect(completedTurnId({ ...completed, title: 'Renamed', updatedAt: 999 })).toBe('turn-1');
    expect(completedTurnId({ ...completed, status: 'running' })).toBeUndefined();
    expect(completedTurnId({ ...completed, lastTurnStatus: undefined })).toBeUndefined();
    expect(completedTurnId({ ...completed, lastTurnId: undefined })).toBeUndefined();
    expect(
      completedTurnId({ ...completed, status: 'completed', lastTurnStatus: 'running' }),
    ).toBeUndefined();
  });

  it('persists read results across page instances without acknowledging a future turn', () => {
    const saved = storage();
    const first = new CompletionReads(() => saved);
    expect(first.isRead('thread', 'turn-1')).toBe(false);
    expect(first.markRead('thread', 'turn-1')).toBe(true);
    const reloaded = new CompletionReads(() => saved);
    expect(reloaded.isRead('thread', 'turn-1')).toBe(true);
    expect(reloaded.isRead('thread', 'turn-2')).toBe(false);
    expect(reloaded.isRead('other-thread', 'turn-1')).toBe(false);
    first.clear('thread', 'turn-1');
    expect(first.isRead('thread', 'turn-1')).toBe(false);
    expect(reloaded.isRead('thread', 'turn-1')).toBe(false);
  });

  it('keeps newer read receipts when an older tab reads an earlier turn afterwards', () => {
    const saved = storage();
    const oldTab = new CompletionReads(() => saved);
    const newTab = new CompletionReads(() => saved);
    newTab.markRead('thread', 'turn-2');
    oldTab.markRead('thread', 'turn-1');
    expect(oldTab.isRead('thread', 'turn-2')).toBe(true);
    expect(newTab.isRead('thread', 'turn-1')).toBe(true);
    expect(newTab.markRead('thread', 'turn-1')).toBe(false);
  });

  it('retains in-page receipts when storage access or writes fail', () => {
    const denied = new CompletionReads(() => {
      throw new Error('denied');
    });
    const full = new CompletionReads(() => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    }));
    for (const reads of [denied, full]) {
      expect(reads.markRead('thread', 'turn')).toBe(true);
      expect(reads.isRead('thread', 'turn')).toBe(true);
      expect(reads.markRead('thread', 'turn')).toBe(false);
    }
  });

  it('keeps IDs with separators distinct and respects cleared browser storage', () => {
    const saved = storage();
    const reads = new CompletionReads(() => saved);
    reads.markRead('a:b', 'c');
    expect(reads.isRead('a', 'b:c')).toBe(false);
    const key = 'codex-web.read-completion:a%3Ab:c';
    saved.setItem(key, '');
    reads.invalidate(key);
    expect(reads.isRead('a:b', 'c')).toBe(false);
  });
});

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { completedTurnId } from '../../shared/thread-summary';
import type { ThreadSummary } from '../../shared/types';
import { HttpError } from '../lib/api';
import type { ProjectThreads } from '../lib/project-threads';
import {
  COMPLETION_READ_PREFIX,
  completionReadKey,
  CompletionReads,
} from '../lib/thread-read-state';

export function useThreadReadState(
  projects: Record<string, ProjectThreads>,
  connected: boolean,
  sendRead: (threadId: string, turnId: string) => Promise<void>,
) {
  const [reads] = useState(() => new CompletionReads());
  const [revision, refresh] = useReducer((version: number) => version + 1, 0);
  const pending = useRef(new Map<string, { threadId: string; turnId: string; retryAt?: number }>());
  const uploading = useRef(false);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(COMPLETION_READ_PREFIX)) return;
      reads.invalidate(event.key);
      refresh();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [reads]);

  useEffect(() => {
    if (!connected || uploading.current) return;
    const queue = pending.current;
    // The same keys carry receipts left by older versions and reads made while offline.
    for (const { data } of Object.values(projects)) {
      for (const thread of data) {
        const turnId = completedTurnId(thread);
        if (turnId && reads.isRead(thread.id, turnId)) {
          const key = completionReadKey(thread.id, turnId);
          if (thread.lastTurnRead) {
            queue.delete(key);
            reads.clear(thread.id, turnId);
          } else if (thread.lastTurnRead === false && !queue.has(key)) {
            queue.set(key, { threadId: thread.id, turnId });
          }
        }
      }
    }
    const now = Date.now();
    const next = [...queue].find(([, receipt]) => (receipt.retryAt ?? 0) <= now);
    if (!next) {
      if (!queue.size) return;
      const retryAt = Math.min(...[...queue.values()].map((receipt) => receipt.retryAt!));
      const timer = window.setTimeout(refresh, retryAt - now);
      return () => window.clearTimeout(timer);
    }
    const [key, receipt] = next;
    const { threadId, turnId } = receipt;
    uploading.current = true;
    const settle = () => {
      queue.delete(key);
      reads.clear(threadId, turnId);
    };
    void sendRead(threadId, turnId)
      .then(settle)
      .catch((problem: unknown) => {
        if (problem instanceof HttpError && [400, 404].includes(problem.status)) {
          settle();
          return;
        }
        receipt.retryAt = Date.now() + 4_000;
      })
      .finally(() => {
        uploading.current = false;
        refresh();
      });
  }, [connected, projects, reads, revision, sendRead]);

  const markCompletedRead = useCallback(
    (threadId: string, turnId: string) => {
      reads.markRead(threadId, turnId);
      pending.current.set(completionReadKey(threadId, turnId), { threadId, turnId });
      refresh();
    },
    [reads],
  );
  const isUnreadCompletion = (thread: ThreadSummary) => {
    const turnId = completedTurnId(thread);
    return Boolean(turnId && !thread.lastTurnRead && !reads.isRead(thread.id, turnId));
  };
  return { isUnreadCompletion, markCompletedRead };
}

import { useCallback, useRef, useState } from 'react';
import type { SavedOperation } from '../lib/operations';

export type QuestionSkipStatus = 'skipping' | 'unknown' | 'failed' | 'skipped' | 'answered';
export type QuestionSkip = { clientOperationId: string; questionIds: string[] };
type Entry = { clientOperationId: string; status: QuestionSkipStatus };
export type QuestionSkips = ReadonlyMap<string, Entry>;
type SkipsByThread = ReadonlyMap<string, QuestionSkips>;

export function useQuestionSkips(operations: SavedOperation[]) {
  const [byThread, setByThread] = useState<SkipsByThread>(() => {
    const restored = new Map<string, Map<string, Entry>>();
    for (const operation of operations) {
      if (!operation.questionSkipIds) continue;
      const entries = restored.get(operation.target) ?? new Map<string, Entry>();
      for (const id of operation.questionSkipIds)
        entries.set(id, { clientOperationId: operation.clientOperationId, status: 'unknown' });
      restored.set(operation.target, entries);
    }
    return restored;
  });
  const current = useRef(byThread);
  const tails = useRef(new Map<string, Promise<void>>());

  const publish = useCallback((threadId: string, entries: QuestionSkips) => {
    current.current = new Map(current.current).set(threadId, entries);
    setByThread(current.current);
  }, []);

  const update = useCallback(
    (
      threadId: string,
      skip: QuestionSkip,
      status: 'failed' | 'unknown' | 'acknowledged',
      skippedIds?: string[],
    ) => {
      const previous = current.current.get(threadId);
      const entries = new Map(previous);
      let changed = false;
      for (const id of skip.questionIds) {
        const entry = previous?.get(id);
        if (
          entry?.clientOperationId !== skip.clientOperationId ||
          (entry.status !== 'skipping' && entry.status !== 'unknown')
        )
          continue;
        // Native history can already contain an answer, making the skip a no-op.
        const next =
          status === 'acknowledged' ? (skippedIds?.includes(id) ? 'skipped' : 'answered') : status;
        if (next === entry.status) continue;
        entries.set(id, { ...entry, status: next });
        changed = true;
      }
      if (changed) publish(threadId, entries);
    },
    [publish],
  );

  const enqueue = (
    threadId: string,
    ids: string[],
    submit: (skip: QuestionSkip) => Promise<void>,
  ) => {
    const entries = new Map(current.current.get(threadId));
    const questionIds = [...new Set(ids)].filter(
      (id) => !entries.has(id) || entries.get(id)?.status === 'failed',
    );
    if (!questionIds.length) return;
    const clientOperationId = crypto.randomUUID();
    const skip = { clientOperationId, questionIds };
    for (const id of questionIds) entries.set(id, { clientOperationId, status: 'skipping' });
    publish(threadId, entries);

    // The queue belongs to the workspace, so closing the dialog or changing threads
    // only cancels reads and navigation. Each submission keeps its original target.
    const previous = tails.current.get(threadId) ?? Promise.resolve();
    const pending = previous
      .then(() => submit(skip))
      .finally(() => {
        if (tails.current.get(threadId) === pending) tails.current.delete(threadId);
      });
    tails.current.set(threadId, pending);
    return pending;
  };

  return { byThread, enqueue, update };
}

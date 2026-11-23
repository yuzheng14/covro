import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadView } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { HistoryWindow } from '../lib/thread-history';
import { HistoryCache } from '../lib/history-cache';
import { readableError } from '../lib/utils';

export function useConversationHistory(
  thread: ThreadView | undefined,
  selectedId: string | undefined,
  options: { projectId: string; scope?: string; forbidden?: boolean },
) {
  const { projectId, scope, forbidden } = options;
  const cache = useMemo(() => (scope ? new HistoryCache(scope) : undefined), [scope]);
  const windowRef = useRef<HistoryWindow | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const latestCached = useRef(false);
  const unverified = useRef(new Set<string>());
  const cacheExhausted = useRef(false);
  const failedCursor = useRef<string | undefined>(undefined);
  const errorRef = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{
    id?: string;
    scope?: string;
    thread?: ThreadView;
    loading: boolean;
    cached: boolean;
    cacheExhausted?: boolean;
    error?: string;
  }>({ loading: false, cached: false });
  const publish = useCallback(
    (loading = false) => {
      setState({
        id: windowRef.current?.latest.id,
        scope,
        thread: windowRef.current?.view,
        loading,
        cached: latestCached.current || unverified.current.size > 0,
        cacheExhausted: cacheExhausted.current,
        error: errorRef.current,
      });
    },
    [scope],
  );
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    windowRef.current = undefined;
    latestCached.current = false;
    unverified.current.clear();
    cacheExhausted.current = false;
    failedCursor.current = undefined;
    errorRef.current = undefined;
    setState({ id: selectedId, scope, loading: false, cached: false });
    let active = true;
    if (selectedId && !forbidden)
      void cache?.read(projectId, selectedId).then((saved) => {
        if (!active || !saved || windowRef.current) return;
        windowRef.current = new HistoryWindow(saved);
        latestCached.current = true;
        publish();
      });
    if (selectedId && forbidden) void cache?.remove(projectId, selectedId);
    return () => {
      active = false;
      pending.current?.abort();
    };
  }, [selectedId, projectId, cache, scope, forbidden, publish]);
  useEffect(() => {
    if (!thread || thread.id !== selectedId || forbidden) return;
    if (windowRef.current?.latest.id === thread.id) windowRef.current.update(thread);
    else windowRef.current = new HistoryWindow(thread);
    latestCached.current = false;
    if (!windowRef.current.chunks.length) unverified.current.clear();
    publish(Boolean(pending.current));
  }, [thread, selectedId, scope, forbidden, publish]);
  useEffect(() => {
    if (!thread || forbidden || thread.id !== selectedId) return;
    // Avoid a write for every streamed token; history remains usable when storage fails.
    const timer = setTimeout(
      () => {
        void cache?.write(thread);
      },
      thread.status === 'running' ? 750 : 0,
    );
    return () => clearTimeout(timer);
  }, [thread, selectedId, cache, forbidden]);
  const loadOlder = useCallback(async () => {
    const window = windowRef.current;
    let cursor = failedCursor.current ?? window?.cursor;
    if (!window || !cursor || pending.current || forbidden) return;
    const controller = new AbortController();
    pending.current = controller;
    errorRef.current = undefined;
    publish(true);
    try {
      const saved = await cache?.read(projectId, window.latest.id, cursor);
      if (controller.signal.aborted || windowRef.current !== window) return;
      if (saved && window.cursor === cursor) {
        window.append(cursor, saved);
        unverified.current.add(cursor);
        publish(true);
      }
      // Reconcile only cached pages opened during this visit, one request at a time.
      // This also catches up pages read offline after an earlier request failed.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
      while (cursor) {
        const page = await api.threadHistory(window.latest.id, cursor, signal);
        if (controller.signal.aborted || windowRef.current !== window) return;
        window.replace(cursor, page);
        unverified.current.delete(cursor);
        for (const key of unverified.current) {
          if (!window.chunks.some((chunk) => chunk.cursor === key)) unverified.current.delete(key);
        }
        failedCursor.current = undefined;
        cacheExhausted.current = false;
        void cache?.write(page, cursor);
        cursor = unverified.current.values().next().value;
        publish(Boolean(cursor));
      }
    } catch (problem) {
      if (!controller.signal.aborted && windowRef.current === window) {
        failedCursor.current = cursor;
        errorRef.current = readableError(problem);
        if (problem instanceof HttpError && [401, 403, 404].includes(problem.status)) {
          void cache?.remove(projectId, window.latest.id);
          windowRef.current = undefined;
        }
        publish();
      }
    } finally {
      if (pending.current === controller) pending.current = undefined;
    }
  }, [publish, cache, projectId, forbidden]);
  const loadCachedOlder = useCallback(async () => {
    const window = windowRef.current;
    const cursor = window?.cursor;
    if (!window || !cursor || !cache || pending.current || forbidden) return;
    const controller = new AbortController();
    pending.current = controller;
    publish(true);
    try {
      const saved = await cache.read(projectId, window.latest.id, cursor);
      if (controller.signal.aborted || windowRef.current !== window) return;
      if (saved) {
        window.append(cursor, saved);
        unverified.current.add(cursor);
      } else cacheExhausted.current = true;
      publish();
    } finally {
      if (pending.current === controller) pending.current = undefined;
    }
  }, [cache, projectId, forbidden, publish]);
  const getHistoryCursor = useCallback(
    (targetId: string) => windowRef.current?.getHistoryCursor(targetId),
    [],
  );
  const valid = !forbidden && state.id === selectedId && state.scope === scope;
  return {
    ...state,
    cached: valid && state.cached,
    loading: valid && state.loading,
    error: valid ? state.error : undefined,
    // Render the current projection on the same commit as a selection change.
    thread: forbidden
      ? undefined
      : ((valid ? state.thread : undefined) ?? (thread?.id === selectedId ? thread : undefined)),
    loadOlder,
    loadCachedOlder,
    getHistoryCursor,
  };
}

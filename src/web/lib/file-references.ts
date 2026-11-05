import { useEffect, useMemo, useState } from 'react';
import type { FileSearchQuery, FileSearchResult } from '../../shared/file-references';
import { request } from './api';
import { readableError } from './utils';

export function fileTrigger(text: string, caret: number, selectionEnd = caret) {
  if (caret !== selectionEnd) return;
  const prefix = text.slice(0, caret);
  const match = /(?:^|[\s([{])@(?:"([^"\n]*)|([^\s`"\\]*))$/u.exec(prefix);
  if (!match || (prefix.match(/`/g)?.length ?? 0) % 2) return;
  const search = match[1] ?? match[2]!;
  const suffix = text.slice(caret);
  const end =
    match[1] !== undefined
      ? caret +
        (suffix.indexOf('"') < 0
          ? (suffix.match(/^[^\n]*/u)?.[0].length ?? 0)
          : suffix.indexOf('"') + 1)
      : caret + (suffix.match(/^[^\s`"\\]*/u)?.[0].length ?? 0);
  return { start: caret - search.length - (match[1] !== undefined ? 2 : 1), end, search };
}

/** Debounce traversal and gate even the render before effect cleanup, including retries. */
export function useFileSearch(query: FileSearchQuery | undefined, scope: string) {
  const identity = JSON.stringify([query, scope]);
  const [attempt, setAttempt] = useState(0);
  // Returning to an earlier query still starts a fresh generation, with no cached snapshot.
  const generation = useMemo(() => ({ identity, attempt }), [identity, attempt]);
  const [state, setState] = useState<{
    generation: typeof generation;
    result?: FileSearchResult;
    error?: string;
  }>();
  useEffect(() => {
    if (!query?.query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request<FileSearchResult>('/api/files/search', query, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setState({ generation, result });
        },
        (error) => {
          if (!controller.signal.aborted) setState({ generation, error: readableError(error) });
        },
      );
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [generation]);
  const current = state?.generation === generation ? state : undefined;
  return {
    ...current,
    loading: Boolean(query?.query && !current),
    refresh: () => setAttempt((n) => n + 1),
  };
}

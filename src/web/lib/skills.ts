import { useEffect, useState } from 'react';
import type { SkillCatalog, SkillQuery } from '../../shared/skills';
import { request } from './api';
import { readableError } from './utils';

/** Identity-gated results prevent a late response from crossing draft/session/runtime boundaries. */
export function useSkills(query: SkillQuery | undefined, runtimeKey: string | undefined) {
  const identity = JSON.stringify([query, runtimeKey]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    identity: string;
    attempt: number;
    catalog?: SkillCatalog;
    error?: string;
  }>();
  useEffect(() => {
    if (!query || !runtimeKey) return;
    const controller = new AbortController();
    void request<SkillCatalog>(
      '/api/skills/list',
      { ...query, forceReload: true },
      controller.signal,
    ).then(
      (catalog) => {
        if (!controller.signal.aborted) setState({ identity, attempt, catalog });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ identity, attempt, error: readableError(error) });
      },
    );
    return () => controller.abort();
    // The serialized identity contains the entire query.
  }, [identity, attempt]);
  const current = state?.identity === identity && state.attempt === attempt ? state : undefined;
  return {
    catalog: current?.catalog,
    error: current?.error,
    loading: Boolean(query && runtimeKey && !current),
    refresh: () => setAttempt((n) => n + 1),
  };
}

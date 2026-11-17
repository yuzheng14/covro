import { t } from '../i18n';
import { useEffect, useState } from 'react';
import type { RuntimeSettings } from '../../shared/types';
import { api } from '../lib/api';

/** A project or runtime change must never show another project's defaults. */
export function useRuntimeDefaults(projectId?: string, runtimeKey?: string) {
  const [attempt, setAttempt] = useState(0);
  const key = projectId && runtimeKey ? JSON.stringify([projectId, runtimeKey, attempt]) : '';
  const [result, setResult] = useState<{
    key: string;
    value?: RuntimeSettings;
    error?: string;
  }>();
  useEffect(() => {
    if (!key || !projectId) return;
    let cancelled = false;
    void api.runtimeSettings(projectId).then(
      (value) => {
        if (!cancelled) setResult({ key, value });
      },
      () => {
        if (!cancelled) setResult({ key, error: t('workspace:cannot_read_default_settings') });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, projectId]);
  useEffect(() => {
    const update = () => setAttempt((value) => value + 1);
    window.addEventListener('covro:defaults-updated', update);
    const channel =
      typeof BroadcastChannel === 'function' ? new BroadcastChannel('covro-defaults') : undefined;
    channel?.addEventListener('message', update);
    return () => {
      window.removeEventListener('covro:defaults-updated', update);
      channel?.close();
    };
  }, []);
  return {
    value: result?.key === key ? result.value : undefined,
    error: result?.key === key ? result.error : undefined,
    loading: Boolean(key && result?.key !== key),
    retry: () => setAttempt((value) => value + 1),
  };
}

import { message } from '../i18n/messages';
import { t } from '../i18n';
import type { CodexUpdateConfirmation } from '../../shared/codex-compatibility';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReleaseChannel, UpdateSettings, UpdateStatus } from '../../shared/updates';
import { request } from '../lib/api';
import { reloadForUpgrade } from '../lib/upgrade-reload';

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const reloading = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const accept = useCallback(async (next: UpdateStatus) => {
    if (!mounted.current) return;
    setStatus(next);
    setError(undefined);
    const builtVersion = import.meta.env.VITE_COVRO_VERSION as string | undefined;
    if (
      !import.meta.env.DEV &&
      builtVersion &&
      next.version !== 'unknown' &&
      next.version !== builtVersion &&
      !reloading.current &&
      (!next.run ||
        next.run.committed ||
        ['rolledBack', 'failed', 'cancelled'].includes(next.run.phase))
    ) {
      reloading.current = true;
      try {
        await reloadForUpgrade();
      } catch (error) {
        reloading.current = false;
        setReloadError(
          error instanceof Error
            ? error.message
            : t('updates:draft_backup_failed_page_reload_postponed'),
        );
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const started = revision.current;
      try {
        const next = await request<UpdateStatus>('/api/updates');
        if (active && started === revision.current) await accept(next);
      } catch {
        if (active)
          setError(message('updates:connection_interrupted_waiting_for_the_service_to_recover'));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      mounted.current = false;
      active = false;
      clearInterval(timer);
    };
  }, [accept]);
  const perform = useCallback(
    async (path: string, body: object) => {
      revision.current++;
      setBusy(true);
      setError(undefined);
      try {
        await accept(await request<UpdateStatus>(path, body));
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : message('updates:operation_unconfirmed_check_update_status'),
        );
      } finally {
        setBusy(false);
        revision.current++;
      }
    },
    [accept],
  );
  return {
    status,
    error,
    busy,
    reloadError,
    check: (channel: ReleaseChannel) => perform('/api/updates/check', { channel }),
    configure: (settings: UpdateSettings) => perform('/api/updates/settings', settings),
    cancel: (id: string) => perform('/api/updates/cancel', { id }),
    start: (
      channel: ReleaseChannel,
      allowDowngrade: boolean,
      codexConfirmation?: CodexUpdateConfirmation,
    ) =>
      perform('/api/updates/run', {
        clientOperationId: crypto.randomUUID(),
        channel,
        allowDowngrade,
        codexConfirmation,
      }),
  };
}
export type Updates = ReturnType<typeof useUpdates>;

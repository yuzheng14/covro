import { message } from '../i18n/messages';
import { t } from '../i18n';
import type { CodexUpdateConfirmation } from '../../shared/codex-compatibility';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  updateCanCheck,
  type ReleaseChannel,
  type UpdateSettings,
  type UpdateStatus,
} from '../../shared/updates';
import { request } from '../lib/api';
import { reloadForUpgrade } from '../lib/upgrade-reload';

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [reloadError, setReloadError] = useState<string>();
  const reloading = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const mutation = useRef(false);
  const checkRequest = useRef<AbortController | undefined>(undefined);
  const latest = useRef<UpdateStatus | undefined>(undefined);
  const accept = useCallback(async (next: UpdateStatus) => {
    if (!mounted.current) return;
    latest.current = next;
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
        if (active && !mutation.current && started === revision.current) await accept(next);
      } catch {
        if (active && !mutation.current && started === revision.current)
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
      checkRequest.current?.abort();
      clearInterval(timer);
    };
  }, [accept]);
  const perform = useCallback(
    async (path: string, body: object) => {
      if (mutation.current) return false;
      mutation.current = true;
      checkRequest.current?.abort();
      checkRequest.current = undefined;
      setChecking(false);
      setCheckError(undefined);
      revision.current++;
      setBusy(true);
      setError(undefined);
      try {
        await accept(await request<UpdateStatus>(path, body));
        return true;
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : message('updates:operation_unconfirmed_check_update_status'),
        );
        return false;
      } finally {
        mutation.current = false;
        setBusy(false);
        revision.current++;
      }
    },
    [accept],
  );
  const check = async (channel?: ReleaseChannel) => {
    if (checkRequest.current || mutation.current || !updateCanCheck(latest.current?.run)) return;
    const before = latest.current;
    const controller = new AbortController();
    checkRequest.current = controller;
    setChecking(true);
    setCheckError(undefined);
    setError(undefined);
    try {
      const next = await request<UpdateStatus>(
        '/api/updates/check',
        channel ? { channel } : {},
        AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      );
      if (controller.signal.aborted) return;
      const current = latest.current;
      if (
        before &&
        current &&
        ((before.settings.channel !== current.settings.channel &&
          next.settings.channel !== current.settings.channel) ||
          (before.settings.automatic !== current.settings.automatic &&
            next.settings.automatic !== current.settings.automatic))
      )
        return;
      // A poll can observe installation while a waiting-phase response is still in flight.
      const run = current?.run;
      if (
        run &&
        (!next.run ||
          run.startedAt > next.run.startedAt ||
          (run.id === next.run.id &&
            (run.updatedAt > next.run.updatedAt ||
              (run.transactionStartedAt && !next.run.transactionStartedAt))))
      )
        return;
      revision.current++;
      await accept(next);
    } catch (error) {
      if (!controller.signal.aborted && updateCanCheck(latest.current?.run))
        setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      if (checkRequest.current === controller) {
        checkRequest.current = undefined;
        setChecking(false);
      }
    }
  };
  return {
    status,
    error,
    busy,
    checking,
    checkError,
    reloadError,
    check,
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

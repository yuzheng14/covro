import { useEffect, useRef, useState } from 'react';
import {
  restartActive,
  restartRecoveryMs,
  type RestartRequest,
  type RestartStatus,
} from '../../shared/service-restart';
import type { Operation } from '../../shared/types';
import { HttpError, request } from '../lib/api';

const endpoint = '/api/service-restart';

export function useServiceRestart(open: boolean, authRequired: boolean) {
  const [status, setStatus] = useState<RestartStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [lostAt, setLostAt] = useState<number>();
  const [visibleId, setVisibleId] = useState<string>();
  const pending = useRef<RestartRequest>(undefined);
  const submitting = useRef(false);
  const active = restartActive(status?.run);

  useEffect(() => {
    if (authRequired) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<RestartStatus>(
          endpoint,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
        );
        if (controller.signal.aborted) return;
        setStatus(next);
        setLostAt(undefined);
        if (restartActive(next.run)) setVisibleId(next.run?.id);
        if (pending.current && next.run && pending.current.afterId !== next.run.id) {
          pending.current = undefined;
          setUnknown(false);
        }
      } catch {
        if (!controller.signal.aborted) setLostAt((time) => time ?? Date.now());
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), open || active || unknown ? 750 : 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, authRequired, open, unknown]);

  async function run(action: () => Promise<void>, starting: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch (error) {
      if (starting && !(error instanceof HttpError && error.status < 500)) {
        if (pending.current) setUnknown(true);
      } else {
        if (starting) pending.current = undefined;
        setUnknown(false);
        setFailed(true);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const refresh = async () => setStatus(await request<RestartStatus>(endpoint));
  return {
    status,
    active,
    busy,
    failed,
    unknown,
    disconnected: lostAt !== undefined,
    unreachable: lostAt !== undefined && Date.now() - lostAt >= restartRecoveryMs,
    showInWorkspace: !!status?.run && status.run.id === visibleId,
    dismiss: () => setVisibleId(undefined),
    start: () =>
      run(async () => {
        if (!status?.supported || active) return;
        const input = (pending.current ??= {
          clientOperationId: crypto.randomUUID(),
          afterId: status.run?.id ?? null,
        });
        const receipt = await request<Operation>(endpoint, input);
        if (receipt.status !== 'acknowledged')
          throw new HttpError(409, receipt.error ?? { code: 'RESTART_FAILED', message: '' });
        const result = receipt.result as { restartId: string };
        setVisibleId(result.restartId);
        pending.current = undefined;
        setUnknown(false);
        // The POST acknowledges the intent. Only the durable run reports restart progress.
        await refresh().catch(() => {});
      }, true),
    cancel: () =>
      run(async () => {
        if (status?.run?.phase !== 'waiting') return;
        setStatus(await request<RestartStatus>(`${endpoint}/cancel`, { id: status.run.id }));
      }, false),
  };
}

export type ServiceRestart = ReturnType<typeof useServiceRestart>;

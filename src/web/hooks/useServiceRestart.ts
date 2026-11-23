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

export function useServiceRestart() {
  const [status, setStatus] = useState<RestartStatus>();
  const [connection, setConnection] = useState<'offline' | 'unreachable'>();
  const [error, setError] = useState<'failed' | 'unknown'>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<RestartRequest>(undefined);
  const submitting = useRef(false);
  const active = restartActive(status?.run);

  useEffect(() => {
    const controller = new AbortController();
    let lostAt: number | undefined;
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
        lostAt = undefined;
        setConnection(undefined);
        if (pending.current && next.run && pending.current.afterId !== next.run.id) {
          pending.current = undefined;
          setError(undefined);
        }
      } catch {
        if (controller.signal.aborted) return;
        lostAt ??= Date.now();
        setConnection(Date.now() - lostAt >= restartRecoveryMs ? 'unreachable' : 'offline');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 750);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  async function submit(cancel = false) {
    const run = status?.run;
    if (submitting.current || !status?.supported || connection) return;
    if (cancel ? run?.phase !== 'waiting' : active) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (cancel && run) {
        setStatus(await request<RestartStatus>(`${endpoint}/cancel`, { id: run.id }));
      } else {
        const input = (pending.current ??= {
          clientOperationId: crypto.randomUUID(),
          afterId: run?.id ?? null,
        });
        const receipt = await request<Operation>(endpoint, input);
        if (receipt.status !== 'acknowledged')
          throw new HttpError(409, receipt.error ?? { code: 'RESTART_FAILED', message: '' });
      }
    } catch (failure) {
      if (!cancel && !(failure instanceof HttpError && failure.status < 500)) {
        if (pending.current) setError('unknown');
      } else {
        if (!cancel) pending.current = undefined;
        setError('failed');
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return {
    status,
    active,
    busy,
    error,
    disconnected: connection !== undefined,
    unreachable: connection === 'unreachable',
    submit,
  };
}

export type ServiceRestart = ReturnType<typeof useServiceRestart>;

import { useEffect, useRef, useState } from 'react';
import type { SessionLoop, SessionLoopAction } from '../../shared/session-loop';
import type { Operation } from '../../shared/types';
import { t } from '../i18n';
import { HttpError, request } from '../lib/api';
import { errorMessage } from '../lib/error-message';
import { readableError } from '../lib/utils';

export type RunLoopOperation = (
  threadId: string,
  path: string,
  body: object,
) => Promise<Operation | undefined>;

export function sessionLoopsPath(threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/loops`;
}

export function useSessionLoops<T extends SessionLoop>(path: string, run: RunLoopOperation) {
  const [loops, setLoops] = useState<T[]>();
  const [readError, setReadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false);
  const refreshVersion = useRef(0);

  useEffect(() => {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      clearTimeout(timer);
      controller?.abort();
      const read = (controller = new AbortController());
      try {
        const data = await request<T[]>(
          path,
          undefined,
          AbortSignal.any([read.signal, AbortSignal.timeout(15_000)]),
        );
        if (read.signal.aborted || revision !== refreshVersion.current) return;
        setLoops(data);
        setReadError(undefined);
        if (!submitting.current) setBusy(false);
      } catch (failure) {
        if (!read.signal.aborted && revision === refreshVersion.current) {
          if (failure instanceof HttpError && failure.authenticationRequired) setLoops(undefined);
          setReadError(readableError(failure));
        }
      } finally {
        if (!read.signal.aborted) timer = setTimeout(() => void refresh(), 2_000);
      }
    }
    void refresh();
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      controller?.abort();
      clearTimeout(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [path, revision]);

  async function submit(threadId: string, endpoint: string, body: object) {
    if (busy || submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    setActionError(undefined);
    try {
      const operation = await run(threadId, endpoint, body);
      if (operation?.error) setActionError(errorMessage(operation.error));
      else if (operation?.status === 'unknown') setActionError(t('errors:RESULT_UNKNOWN'));
      return operation?.status === 'acknowledged';
    } catch (failure) {
      setActionError(readableError(failure));
      return false;
    } finally {
      // Keep controls disabled until the post-operation snapshot arrives.
      submitting.current = false;
      setRevision(++refreshVersion.current);
    }
  }

  return {
    loops,
    error: actionError ?? readError,
    controlsDisabled: busy || Boolean(readError),
    setActionError,
    submit,
    control: (loop: SessionLoop, action: SessionLoopAction) =>
      submit(loop.threadId, `${sessionLoopsPath(loop.threadId)}/${encodeURIComponent(loop.id)}`, {
        action,
        version: loop.version,
      }),
  };
}

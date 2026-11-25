import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PendingQuestion, PendingQuestionState } from '../../shared/pending-questions';
import { ArrowUpRight } from 'lucide-react';
import { t } from '../i18n';
import { api } from '../lib/api';
import { readableError } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';

export function PendingQuestionsDialog({
  threadId,
  state,
  canDismiss,
  onClose,
  onLocate,
  onDismiss,
}: {
  threadId: string;
  state: PendingQuestionState;
  canDismiss: boolean;
  onClose: () => void;
  onLocate: (question: PendingQuestion, signal: AbortSignal) => Promise<void>;
  onDismiss: (questionId: string) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<PendingQuestion[]>();
  const [resultHistory, setResultHistory] = useState(state.history);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const requestedRetry = useRef(0);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const action = useRef<AbortController | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
    const rescan = retry > requestedRetry.current;
    requestedRetry.current = retry;
    setLoading(true);
    setError(undefined);
    void (async () => {
      let cursor: string | null = null;
      const result: PendingQuestion[] = [];
      do {
        const page = await api.pendingQuestions(threadId, cursor, signal, rescan);
        result.push(...page.data);
        cursor = page.nextCursor;
        if (!cursor && !controller.signal.aborted) {
          setRows(result);
          setResultHistory(page.history);
        }
      } while (cursor);
    })()
      .catch((problem: unknown) => {
        if (!controller.signal.aborted) setError(readableError(problem));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [threadId, state.version, state.history, retry]);
  useLayoutEffect(() => {
    if (
      lastFocus.current &&
      !lastFocus.current.isConnected &&
      document.activeElement === document.body
    ) {
      (list.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? list.current)?.focus();
      lastFocus.current = undefined;
    }
  }, [rows]);
  const handle = async (row: PendingQuestion, mode: 'locate' | 'dismiss') => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(row.id);
    setActionError(undefined);
    try {
      if (mode === 'locate') {
        await onLocate(row, AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
        if (!controller.signal.aborted) onClose();
      } else if (!(await onDismiss(row.id)) && !controller.signal.aborted) {
        setActionError(t('workspace:question_skip_unconfirmed'));
      }
    } catch (problem) {
      if (!controller.signal.aborted) setActionError(readableError(problem));
    } finally {
      action.current = undefined;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };
  return (
    <CommandDialog
      open
      portal
      title={t('workspace:pending_questions')}
      onClose={onClose}
      className="pending-questions-dialog"
    >
      <div
        ref={list}
        tabIndex={-1}
        className="pending-questions-content"
        onFocus={(event) => {
          lastFocus.current = event.target;
        }}
      >
        {rows && rows.length > 0 && (
          <ul className="pending-question-list">
            {rows.map((row) => (
              <li
                key={JSON.stringify([row.target.kind, row.target.id, row.id])}
                className="pending-question-row"
              >
                <button
                  type="button"
                  className="pending-question-link"
                  aria-disabled={busy !== undefined}
                  onClick={() => void handle(row, 'locate')}
                >
                  <span className="pending-question-turn">
                    {row.turnNumber
                      ? t('conversation:turn', { v0: row.turnNumber })
                      : row.turnId
                        ? t('workspace:question_turn_id', { id: row.turnId.slice(-8) })
                        : t('workspace:question_current_request')}
                    {row.state && (
                      <>
                        {' '}
                        ·{' '}
                        {t(
                          row.state === 'unknown'
                            ? 'workspace:answer_receipt_pending'
                            : 'workspace:sending',
                        )}
                      </>
                    )}
                  </span>
                  <span className="pending-question-summary">{row.summary}</span>
                  <ArrowUpRight className="pending-question-arrow" size={15} aria-hidden="true" />
                </button>
                {row.target.kind === 'question' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!canDismiss || Boolean(row.state)}
                    aria-disabled={busy !== undefined || undefined}
                    title={t('workspace:end_tracking_hint')}
                    onClick={() => void handle(row, 'dismiss')}
                  >
                    {t('workspace:end_question_tracking')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(loading || resultHistory === 'loading') && <p role="status">{t('common:loading_2')}</p>}
        {actionError && (
          <p role="alert" className="inline-error">
            {actionError}
          </p>
        )}
        {!loading && (error || resultHistory === 'error') && (
          <div className="pending-question-retry">
            <p role="alert" className="inline-error">
              {error ?? t('workspace:question_history_incomplete')}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('conversation:retry_loading')}
            </Button>
          </div>
        )}
        {!loading && !error && resultHistory === 'ready' && rows?.length === 0 && (
          <p role="status">{t('workspace:no_pending_questions')}</p>
        )}
      </div>
    </CommandDialog>
  );
}

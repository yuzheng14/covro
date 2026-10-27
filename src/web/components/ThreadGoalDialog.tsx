import { useEffect, useState } from 'react';
import type { GoalMutation, ThreadGoal } from '../../shared/thread-goal';
import type { Operation } from '../../shared/types';
import { t, formatNumber } from '../i18n';
import { request } from '../lib/api';
import { readableError } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';

export function GoalSummary({ goal }: { goal: ThreadGoal }) {
  return (
    <div className="goal-summary">
      <p>{goal.objective}</p>
      <p>
        {t(`commands:goal_${goal.status}`)} ·{' '}
        {t('commands:goalUsageTokens', {
          used: goal.tokensUsed,
          budget: goal.tokenBudget === null ? '—' : formatNumber(goal.tokenBudget),
        })}{' '}
        · {t('commands:goalTime', { seconds: goal.timeUsedSeconds })}
      </p>
    </div>
  );
}
export function ThreadGoalDialog({
  threadId,
  initial,
  onClose,
  run,
  disabled,
  stoppingDisabled,
}: {
  threadId: string;
  initial: string;
  onClose: () => void;
  run: (
    mutation: GoalMutation & { expectedVersion: string; confirm: true },
  ) => Promise<Operation | undefined>;
  disabled: boolean;
  stoppingDisabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ goal: ThreadGoal | null; version: string }>();
  const [error, setError] = useState<string>();
  const [objective, setObjective] = useState(
    /^(edit|pause|resume|clear)$/i.test(initial) ? '' : initial,
  );
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined);
    setError(undefined);
    void request<{ goal: ThreadGoal | null; version: string }>(
      `/api/threads/${encodeURIComponent(threadId)}/goal`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setSnapshot(value);
          setObjective(
            initial && !/^(edit|pause|resume|clear)$/i.test(initial)
              ? initial
              : (value.goal?.objective ?? ''),
          );
          setBudget(value.goal?.tokenBudget?.toString() ?? '');
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      });
    return () => controller.abort();
  }, [threadId, attempt, initial]);
  async function mutate(value: GoalMutation) {
    if (busy || !snapshot) return;
    setBusy(true);
    setError(undefined);
    try {
      const op = await run({ ...value, expectedVersion: snapshot.version, confirm: true });
      if (op?.status === 'acknowledged') setAttempt((n) => n + 1);
      else setError(t('commands:goalUnconfirmed'));
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <CommandDialog open title={t('commands:goalTitle')} onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {!snapshot ? (
        <Button variant="ghost" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
          {t('common:reload')}
        </Button>
      ) : (
        <>
          {snapshot.goal ? <GoalSummary goal={snapshot.goal} /> : <p>{t('commands:goalEmpty')}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate({
                action: 'set',
                objective: objective.trim(),
                status: 'active',
                ...(budget ? { tokenBudget: Number(budget) } : {}),
              });
            }}
          >
            <label className="project-field">
              <span>{t('commands:goalObjective')}</span>
              <textarea
                required
                maxLength={10000}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </label>
            <label className="project-field">
              <span>{t('commands:goalBudget')}</span>
              <input
                type="number"
                min={1}
                max={1000000000}
                step={1}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
            <p>{t('commands:goalActivation')}</p>
            <div className="project-dialog-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t('common:reload')}
              </Button>
              <Button type="submit" disabled={busy || disabled || !objective.trim()}>
                {t('commands:goalActivate')}
              </Button>
            </div>
          </form>
          {snapshot.goal && (
            <div className="project-dialog-actions">
              <Button
                disabled={busy || stoppingDisabled || snapshot.goal.status === 'paused'}
                variant="secondary"
                onClick={() => void mutate({ action: 'set', status: 'paused' })}
              >
                {t('commands:goalPause')}
              </Button>
              <Button
                disabled={busy || stoppingDisabled || snapshot.goal.status === 'complete'}
                variant="secondary"
                onClick={() => void mutate({ action: 'set', status: 'complete' })}
              >
                {t('commands:goalComplete')}
              </Button>
              <Button
                disabled={busy || stoppingDisabled}
                variant="destructive"
                onClick={() => void mutate({ action: 'clear' })}
              >
                {t('commands:goalClear')}
              </Button>
            </div>
          )}
        </>
      )}
    </CommandDialog>
  );
}

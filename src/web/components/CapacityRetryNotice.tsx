import { useEffect, useState } from 'react';
import type { ThreadView } from '../../shared/types';
import { isModelCapacityError } from '../../shared/turn-errors';
import { t } from '../i18n';
import { Button } from './ui/button';
import { ModelCapacityNotice } from './ModelCapacityNotice';

export interface CapacityRetryControls {
  disabled: boolean;
  busy: boolean;
  onCancel: () => void;
  onRetry: (turnId: string) => void;
}

export function CapacityRetryNotice({
  thread,
  offline,
  controls,
}: {
  thread: ThreadView;
  offline: boolean;
  controls?: CapacityRetryControls;
}) {
  const retry = thread.capacityRetry;
  const last = thread.turns.at(-1);
  const capacityFailed =
    last?.status === 'failed' && isModelCapacityError(last.error ?? '', last.errorCode);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (retry?.status !== 'waiting') return;
    const timer = window.setInterval(() => refresh((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [retry?.status, retry?.nextAttemptAt]);
  if (!retry && !capacityFailed) return null;
  const waiting = retry?.status === 'waiting';
  const active = waiting || retry?.status === 'retrying';
  const seconds = Math.max(
    0,
    Math.ceil(((retry?.nextAttemptAt ?? Date.now()) - Date.now()) / 1000),
  );
  const stoppedLabel =
    retry?.status === 'cancelled'
      ? 'capacity_cancelled_short'
      : retry?.reason === 'limit'
        ? 'capacity_limit_short'
        : 'retry_stopped_short';
  return (
    <ModelCapacityNotice
      offline={offline}
      retrying={active}
      testId="capacity-retry-status"
      state={retry?.status ?? 'stopped'}
      details={capacityFailed ? last.error : undefined}
      progress={
        <>
          <span>
            {active && retry
              ? t('conversation:retry_progress', { attempt: retry.attempt, limit: retry.limit })
              : t(`conversation:${stoppedLabel}`)}
          </span>
          {waiting && !offline && (
            <span>
              {t(
                seconds > 0
                  ? 'conversation:capacity_in_seconds_short'
                  : 'conversation:capacity_dispatching',
                { seconds },
              )}
            </span>
          )}
          {controls &&
            (active ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={offline || controls.disabled || controls.busy}
                onClick={controls.onCancel}
              >
                {t('conversation:cancel_retry')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  offline ||
                  controls.disabled ||
                  controls.busy ||
                  !capacityFailed ||
                  Boolean(thread.execution)
                }
                onClick={() => last && controls.onRetry(last.id)}
              >
                {t('conversation:retry_with_selected_model')}
              </Button>
            ))}
        </>
      }
    >
      {retry?.status === 'stopped' && (retry.reason === 'progress' || retry.reason === 'error') && (
        <p className="model-capacity-note">{t(`conversation:capacity_stopped_${retry.reason}`)}</p>
      )}
    </ModelCapacityNotice>
  );
}

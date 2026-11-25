import type { ReactNode } from 'react';
import type { SessionLoop, SessionLoopAction } from '../../shared/session-loop';
import { formatDate, t } from '../i18n';
import { Button } from './ui/button';

export function SessionLoopRow({
  loop,
  archived,
  waiting,
  disabled,
  onControl,
  heading,
}: {
  loop: SessionLoop;
  archived: boolean;
  waiting: boolean;
  disabled: boolean;
  onControl: (action: SessionLoopAction) => void;
  heading?: ReactNode;
}) {
  return (
    <article className="session-loop-row">
      {heading ?? <p className="session-loop-prompt">{loop.prompt}</p>}
      <p>
        {t(`commands:loop_${loop.status}`)} ·{' '}
        {loop.intervalMs === null
          ? t('commands:loopAdaptive')
          : t('commands:loopCadence', { minutes: loop.intervalMs / 60_000 })}{' '}
        · {t('commands:loopRuns', { runs: loop.runs })}
      </p>
      {loop.status === 'active' && (
        <p>
          {loop.nextRunAt === null
            ? t('commands:loopDeciding')
            : t('commands:loopNext', {
                time: formatDate(new Date(loop.nextRunAt), {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }),
              })}
          {waiting && <> · {t('commands:loopWaiting')}</>}
        </p>
      )}
      {loop.lastDecision && (
        <>
          <p className="session-loop-summary">{loop.lastDecision.summary}</p>
          <p>{loop.lastDecision.reason}</p>
        </>
      )}
      {loop.lastResult && !(loop.lastDecision && loop.lastResult === 'completed') && (
        <p>{t('commands:loopLast', { result: t(`commands:loop_${loop.lastResult}`) })}</p>
      )}
      {loop.reason && <p>{t(`commands:loopReason_${loop.reason}`)}</p>}
      {(loop.status === 'active' || loop.status === 'paused') && (
        <div className="session-loop-actions">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={
              disabled || (loop.status === 'paused' && (archived || loop.lastResult === 'unknown'))
            }
            onClick={() => onControl(loop.status === 'active' ? 'pause' : 'resume')}
          >
            {t(loop.status === 'active' ? 'commands:loopPause' : 'commands:loopResume')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onControl('cancel')}
          >
            {t('commands:loopCancel')}
          </Button>
        </div>
      )}
    </article>
  );
}

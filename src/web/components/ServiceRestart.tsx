import { RotateCw } from 'lucide-react';
import { formatList, t } from '../i18n';
import { useServiceRestart, type ServiceRestart } from '../hooks/useServiceRestart';
import { Button } from './ui/button';

function statusText(restart: ServiceRestart, connected: boolean) {
  const run = restart.status?.run;
  if (restart.unreachable) return t('settings:restart_unreachable');
  if (run?.phase === 'failed') return t('settings:restart_failed');
  if (restart.active && restart.disconnected) return t('settings:restart_reconnecting');
  if (!run) return '';
  if (run.phase === 'succeeded' && !connected) return t('settings:restart_reconnecting');
  return t(`settings:restart_phase_${run.phase}`);
}

export function ServiceRestartControl({
  connected,
  editing,
}: {
  connected: boolean;
  editing: boolean;
}) {
  const restart = useServiceRestart();
  const { status } = restart;
  const blockers = status?.blockers ?? [];
  const tasks = formatList(blockers.map((blocker) => t(`settings:restart_blocker_${blocker}`)));
  const text = statusText(restart, connected);
  const waiting = status?.run?.phase === 'waiting';
  return (
    <section className="service-restart" aria-labelledby="service-restart-title">
      <h3 id="service-restart-title">{t('settings:restart_title')}</h3>
      <p>
        {status?.supported === false
          ? t('settings:restart_unsupported')
          : t('settings:restart_description')}
      </p>
      {text && (
        <div
          className="gateway-status"
          role="status"
          data-pending={restart.active}
          data-failed={status?.run?.phase === 'failed' || restart.unreachable}
        >
          <strong>{text}</strong>
          {waiting && tasks && <span>{tasks}</span>}
          {status?.run?.failure && (
            <span>{t(`settings:restart_failure_${status.run.failure}`)}</span>
          )}
        </div>
      )}
      {status?.supported && (
        <Button
          variant="secondary"
          size="sm"
          disabled={
            restart.busy || restart.disconnected || (!waiting && (restart.active || editing))
          }
          onClick={() => void restart.submit(waiting)}
        >
          {!waiting && <RotateCw size={15} aria-hidden="true" />}
          {waiting
            ? t('settings:restart_cancel')
            : t(
                restart.error === 'unknown'
                  ? 'settings:restart_retry_request'
                  : 'settings:restart_when_idle',
              )}
        </Button>
      )}
    </section>
  );
}

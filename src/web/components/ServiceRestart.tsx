import { RotateCw } from 'lucide-react';
import { formatList, t } from '../i18n';
import type { ServiceRestart } from '../hooks/useServiceRestart';
import { Button } from './ui/button';
import { Icon } from './Icon';

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
  restart,
  connected,
  editing,
}: {
  restart: ServiceRestart;
  connected: boolean;
  editing: boolean;
}) {
  const { status } = restart;
  const blockers = status?.blockers ?? [];
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
        <div className="gateway-status" role="status" data-pending={restart.active}>
          <strong>{text}</strong>
          {waiting && blockers.length > 0 && (
            <span>
              {formatList(blockers.map((blocker) => t(`settings:restart_blocker_${blocker}`)))}
            </span>
          )}
          {status?.run?.failure && (
            <span>{t(`settings:restart_failure_${status.run.failure}`)}</span>
          )}
        </div>
      )}
      {status?.supported && !status.run && !blockers.length && !restart.disconnected && (
        <p>{t('settings:restart_idle')}</p>
      )}
      {!restart.active && blockers.length > 0 && !restart.disconnected && (
        <p>
          {t('settings:restart_busy', {
            tasks: formatList(blockers.map((blocker) => t(`settings:restart_blocker_${blocker}`))),
          })}
        </p>
      )}
      {restart.failed && <p role="alert">{t('settings:restart_request_failed')}</p>}
      {restart.unknown && <p role="status">{t('settings:restart_receipt_unknown')}</p>}
      {!status && restart.disconnected && (
        <p role="status">{t('settings:restart_status_unavailable')}</p>
      )}
      {status?.run && (status.run.failure || restart.unreachable) && (
        <details>
          <summary>{t('common:technical_details')}</summary>
          <p>{t('settings:restart_recovery_help')}</p>
          <code>{status.run.id}</code>
        </details>
      )}
      {status?.supported &&
        (waiting ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={restart.busy || restart.disconnected}
            onClick={restart.cancel}
          >
            {t('settings:restart_cancel')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={restart.active || restart.busy || restart.disconnected || editing}
            onClick={restart.start}
          >
            <RotateCw size={15} aria-hidden="true" />
            {t(restart.unknown ? 'settings:restart_retry_request' : 'settings:restart_when_idle')}
          </Button>
        ))}
    </section>
  );
}

export function ServiceRestartNotice({
  restart,
  connected,
  onOpen,
}: {
  restart: ServiceRestart;
  connected: boolean;
  onOpen: () => void;
}) {
  if (!restart.showInWorkspace) return null;
  return (
    <div className="connection-banner" role="status">
      <span>{statusText(restart, connected)}</span>
      <Button variant="ghost" size="sm" onClick={onOpen}>
        {t('common:service_settings')}
      </Button>
      {(!restart.active || restart.unreachable) && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:close')}
          onClick={restart.dismiss}
        >
          <Icon name="close" size={16} />
        </Button>
      )}
    </div>
  );
}

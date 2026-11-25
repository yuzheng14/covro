import { SettingsSurface } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import { DatabaseBackup, RefreshCw, ShieldCheck } from 'lucide-react';
import type { BackupStatus } from '../../shared/backups';
import { t, formatNumber, formatDate } from '../i18n';
import { displayMessage, message, messageDetails } from '../i18n/messages';
import { errorMessage } from '../lib/error-message';
import { HttpError, request } from '../lib/api';
import { Button } from './ui/button';
import { Icon } from './Icon';

function size(bytes: number) {
  const mib = bytes >= 1024 * 1024;
  return `${formatNumber(bytes / (mib ? 1024 * 1024 : 1024), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ${mib ? 'MiB' : 'KiB'}`;
}
function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof HttpError
    ? errorMessage(failure.problem)
    : message(fallback, { details: failure instanceof Error ? failure.message : undefined });
}
function TechnicalDetails({ value }: { value?: string }) {
  return value ? (
    <details className="backup-technical-details">
      <summary>{t('common:technical_details')}</summary>
      <pre>{value}</pre>
    </details>
  ) : null;
}
export function BackupSettings({ onClose: onDismiss }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onClose = () => {
    dialog.current?.close();
    onDismiss();
  };
  const [status, setStatus] = useState<BackupStatus>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const generation = useRef(0);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pendingId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const active = status?.active;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const revision = generation.current;
      try {
        const next = await request<BackupStatus>('/api/backups', undefined, controller.signal);
        if (controller.signal.aborted || revision !== generation.current) return;
        setLoadError(undefined);
        setStatus(next);
        if (next.records.some((record) => record.id === pendingId.current))
          pendingId.current = undefined;
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError(failureMessage(failure, 'backups:loadFailed'));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
      element?.close();
    };
  }, []);
  async function act(path: string, body: object, success?: string) {
    generation.current++;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await request<BackupStatus>(path, body);
      if (mounted.current) {
        setStatus(next);
        setNotice(success);
        pendingId.current = undefined;
      }
    } catch (failure) {
      if (mounted.current) setError(failureMessage(failure, 'backups:operationFailed'));
    } finally {
      generation.current++;
      if (mounted.current) setBusy(false);
    }
  }
  const records = status?.records ?? [];
  const complete = records.filter((record) => record.phase === 'succeeded');
  const total = complete.reduce(
    (sum, record) =>
      sum + (record.manifest?.files.reduce((bytes, file) => bytes + file.size, 0) ?? 0),
    0,
  );
  return (
    <SettingsSurface
      ref={dialog}
      className="project-dialog backup-dialog"
      aria-labelledby="backup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <DatabaseBackup size={20} aria-hidden="true" />
          <h2 id="backup-title">{t('backups:title')}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('backups:close')} onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="subtle">{t('backups:introduction')}</p>
      <section className="backup-summary" aria-label={t('backups:overview')}>
        <span>{t('backups:currentSchema', { version: String(status?.schemaVersion ?? '…') })}</span>
        <span>
          {t('backups:completed', {
            count: complete.length,
            number: formatNumber(complete.length),
            size: size(total),
          })}
        </span>
      </section>
      <div className="backup-actions">
        <Button
          disabled={!status?.supported || busy || Boolean(active)}
          onClick={() => {
            pendingId.current ??= crypto.randomUUID();
            void act('/api/backups', { clientOperationId: pendingId.current });
          }}
        >
          <DatabaseBackup size={16} aria-hidden="true" />
          {busy ? t('backups:processing') : t('backups:create')}
        </Button>
        {active && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void act(`/api/backups/${encodeURIComponent(active.id)}/cancel`, {})}
          >
            {t('backups:cancel')}
          </Button>
        )}
      </div>
      {active && (
        <section className="backup-progress" role="status" aria-label={t('backups:progress')}>
          <strong>{t(`backups:phase_${active.phase}`)}</strong>
          <p>{t(`backups:description_${active.phase}`)}</p>
          <TechnicalDetails value={active.message} />
          {active.phase !== 'waiting' && (
            <progress
              aria-label={t('backups:databaseProgress')}
              max={100}
              value={active.progress}
            />
          )}
          <p className="subtle">{t('backups:continues')}</p>
        </section>
      )}
      {(error || loadError) && (
        <div className="inline-error" role="alert">
          <p>{displayMessage(error ?? loadError)}</p>
          <TechnicalDetails value={messageDetails(error ?? loadError)} />
        </div>
      )}
      {notice && (
        <p className="backup-notice" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          {displayMessage(notice)}
        </p>
      )}
      {status?.unsupportedReason && (
        <div className="inline-error">
          <p>{t('backups:unavailable')}</p>
          <TechnicalDetails value={status.unsupportedReason} />
        </div>
      )}
      <h3>{t('backups:records')}</h3>
      {!status && !error && !loadError && <p className="subtle">{t('backups:loading')}</p>}
      {status && !records.length && <p className="backup-empty">{t('backups:empty')}</p>}
      <ol className="backup-records">
        {records.map((record) => (
          <li key={record.id} className="backup-record" data-phase={record.phase}>
            <div className="backup-record-heading">
              <strong>{t(`backups:phase_${record.phase}`)}</strong>
              <span>{t(`backups:trigger_${record.trigger}`)}</span>
            </div>
            <time dateTime={new Date(record.createdAt).toISOString()}>
              {formatDate(new Date(record.createdAt), { dateStyle: 'short', timeStyle: 'medium' })}
            </time>
            {record.manifest && (
              <p>
                Covro {record.manifest.appVersion} · Schema {record.manifest.schemaVersion} ·{' '}
                {size(record.manifest.files.reduce((sum, file) => sum + file.size, 0))}
              </p>
            )}
            <p
              className="backup-record-message"
              role={
                ['failed', 'corrupt', 'interrupted'].includes(record.phase) ? 'alert' : undefined
              }
            >
              {t(`backups:description_${record.phase}`)}
            </p>
            <TechnicalDetails value={record.message} />
            {record.manifest?.protectedBy && <p className="subtle">{t('backups:protected')}</p>}
            <code className="backup-path">{record.path}</code>
            {record.manifest && !['waiting', 'copying', 'verifying'].includes(record.phase) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || Boolean(active)}
                onClick={() =>
                  void act(
                    `/api/backups/${encodeURIComponent(record.id)}/verify`,
                    {},
                    message('backups:verified'),
                  )
                }
              >
                <RefreshCw size={13} aria-hidden="true" />
                {t('backups:verify')}
              </Button>
            )}
            {record.phase === 'succeeded' && (
              <details className="backup-restore">
                <summary>{t('backups:recovery')}</summary>
                <p>{t('backups:recoveryWarning')}</p>
                <code>
                  covro backup restore {record.id} --config{' '}
                  {JSON.stringify(record.manifest?.configPath)}
                </code>
                <p>{t('backups:recoveryPreview')}</p>
              </details>
            )}
          </li>
        ))}
      </ol>
      <section className="backup-scope" aria-label={t('backups:scope')}>
        <h3>{t('backups:scopeTitle')}</h3>
        <p>{t('backups:included')}</p>
        <p>{t('backups:retention')}</p>
        {status && (
          <>
            <span>{t('backups:directory')}</span>
            <code className="backup-path">{status.directory}</code>
          </>
        )}
      </section>
    </SettingsSurface>
  );
}

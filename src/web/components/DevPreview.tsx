import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, Monitor } from 'lucide-react';
import type { PreviewSettings, PreviewSnapshot } from '../../shared/dev-preview';
import { request } from '../lib/api';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { CommandDialog } from './CommandDialog';
import './dev-preview.css';

export function DevPreview({ threadId }: { threadId?: string }) {
  const enableId = useId();
  const fullId = useId();
  const riskId = useId();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [changed, setChanged] = useState(false);
  const saving = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(undefined);
    const refresh = async () => {
      const started = revision.current;
      try {
        const value = threadId
          ? await request<PreviewSnapshot>(
              `/api/threads/${encodeURIComponent(threadId)}/preview`,
              undefined,
              controller.signal,
            )
          : {
              services: [],
              available: true,
              settings: await request<PreviewSettings>(
                '/api/preview/settings',
                undefined,
                controller.signal,
              ),
            };
        if (!controller.signal.aborted && !saving.current && started === revision.current) {
          setSnapshot(value);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), open ? 1000 : 3000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [threadId, open]);
  const running = snapshot?.services.filter((service) => service.status === 'running').length ?? 0;
  const configure = async (settings: PreviewSettings) => {
    if (saving.current) return;
    revision.current++;
    saving.current = true;
    setBusy(true);
    setError(false);
    try {
      const next = await request<PreviewSettings>('/api/preview/settings', settings);
      setSnapshot((previous) => ({ services: [], available: true, ...previous, settings: next }));
      setChanged(true);
    } catch {
      setError(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const launch = async (id: string) => {
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError(true);
      return;
    }
    tab.opener = null;
    setBusy(true);
    setError(false);
    try {
      const result = await request<{ url: string }>(
        `/api/preview/services/${encodeURIComponent(id)}/open`,
        {},
      );
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || !/^\/preview\/[A-Za-z0-9_-]{43}\/$/.test(url.pathname))
        throw new Error('Invalid preview destination');
      tab.location.replace(url.href);
    } catch {
      tab.close();
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="dev-preview-entry"
        aria-label={t('preview:dev_title')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Monitor size={16} aria-hidden="true" />
        <span>{t('preview:dev_preview')}</span>
        {running > 0 && <span className="dev-preview-count">{running}</span>}
      </Button>
      {open && (
        <CommandDialog
          open
          title={t('preview:dev_title')}
          onClose={() => setOpen(false)}
          className="dev-preview-dialog"
        >
          <div className="dev-preview-settings">
            <label htmlFor={enableId}>
              <span>{t('preview:dev_enable')}</span>
              <Switch
                id={enableId}
                checked={snapshot?.settings.enabled ?? false}
                disabled={!snapshot}
                aria-disabled={busy || undefined}
                onCheckedChange={(checked) =>
                  void configure({
                    enabled: checked,
                    fullRequests: checked && (snapshot?.settings.fullRequests ?? false),
                  })
                }
              />
            </label>
            <label htmlFor={fullId}>
              <span>{t('preview:dev_full')}</span>
              <Switch
                id={fullId}
                aria-describedby={riskId}
                checked={snapshot?.settings.fullRequests ?? false}
                disabled={!snapshot?.settings.enabled}
                aria-disabled={busy || undefined}
                onCheckedChange={(checked) =>
                  void configure({ enabled: true, fullRequests: checked })
                }
              />
            </label>
            <p className="dev-preview-risk" id={riskId}>
              {t('preview:dev_risk')}
            </p>
          </div>
          {error && <p role="alert">{t('preview:dev_failed')}</p>}
          {changed && (
            <p className="dev-preview-notice" role="status">
              {t('preview:dev_reopen')}
            </p>
          )}
          {snapshot?.error && <p role="status">{t('preview:dev_inspection_failed')}</p>}
          {snapshot?.available === false ? (
            <p role="status">{t('preview:dev_unavailable')}</p>
          ) : snapshot?.services.length ? (
            <ul className="dev-preview-services">
              {snapshot.services.map((service) => (
                <li key={service.id}>
                  <div className="dev-preview-service">
                    <strong title={service.projectName}>
                      {service.projectId === null
                        ? t('preview:dev_workspace')
                        : service.projectName}
                    </strong>
                    <code>:{service.port}</code>
                    <span className={service.status === 'running' ? 'dev-preview-running' : ''}>
                      {t(
                        service.status === 'running'
                          ? 'preview:dev_running'
                          : 'preview:dev_withdrawn',
                      )}
                    </span>
                  </div>
                  <code className="dev-preview-command">{service.command}</code>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!snapshot.settings.enabled || busy || service.status !== 'running'}
                    onClick={() => void launch(service.id)}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    {t('preview:dev_open')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dev-preview-empty" role="status">
              {t('preview:dev_empty')}
            </p>
          )}
        </CommandDialog>
      )}
    </>
  );
}

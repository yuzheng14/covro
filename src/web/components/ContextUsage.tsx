import { t, formatNumber, formatDate } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionTokenUsage, TokenUsageBreakdown } from '../../shared/types';
import { contextUsagePercent, contextUsageStatus, formatTokenCount } from '../lib/context-usage';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';
import { Button } from './ui/button';

const counters: [keyof TokenUsageBreakdown, string][] = [
  ['totalTokens', 'settings:context_totalTokens'],
  ['inputTokens', 'settings:context_inputTokens'],
  ['cachedInputTokens', 'settings:context_cachedInputTokens'],
  ['cacheWriteInputTokens', 'settings:context_cacheWriteInputTokens'],
  ['outputTokens', 'settings:context_outputTokens'],
  ['reasoningOutputTokens', 'settings:context_reasoningOutputTokens'],
];

function UsageDetails({ usage }: { usage?: SessionTokenUsage }) {
  return (
    <>
      <table className="context-usage-table">
        <caption className="sr-only">{t('settings:context_token_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('settings:context_token')}</th>
            <th scope="col">{t('settings:context_last')}</th>
            <th scope="col">{t('settings:context_total')}</th>
          </tr>
        </thead>
        <tbody>
          {counters.map(([field, label]) => (
            <tr key={field}>
              <th scope="row">{t(label)}</th>
              <td>{formatTokenCount(usage?.last?.[field])}</td>
              <td>{formatTokenCount(usage?.total?.[field])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="context-usage-window">
        <span>{t('settings:context_window')}</span>
        <strong>{formatTokenCount(usage?.modelContextWindow)}</strong>
      </div>
    </>
  );
}

export function ContextUsage({
  usage,
  offline,
  onRefresh,
}: {
  usage?: SessionTokenUsage;
  offline: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const percent = contextUsagePercent(usage);
  const status = contextUsageStatus(usage, offline);
  const percentLabel =
    percent === undefined
      ? t('common:not_reported')
      : `${formatNumber(percent, { maximumFractionDigits: 0 })}%`;
  useEffect(() => {
    const element = dialog.current;
    if (!expanded || !element) return;
    element.showModal();
    return () => {
      element.close();
      trigger.current?.focus();
    };
  }, [expanded]);
  return (
    <>
      <ControlHint
        content={
          <>
            <strong>{t('settings:context_tooltip', { percent: percentLabel })}</strong>
            <span>{status}</span>
            <span>
              {t('settings:context_last')} · {formatTokenCount(usage?.last?.totalTokens)} tokens
            </span>
            <span>
              {t('settings:context_window')} · {formatTokenCount(usage?.modelContextWindow)}
            </span>
            <span>
              {t('settings:context_total')} · {formatTokenCount(usage?.total?.totalTokens)} tokens
            </span>
            <span>{t('settings:context_details')}</span>
          </>
        }
        suppressed={expanded}
      >
        <button
          ref={trigger}
          type="button"
          className="context-usage-trigger"
          aria-label={t('settings:context_trigger')}
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
          data-percent={percent === undefined ? 'unknown' : percent}
          data-stale={offline || Boolean(usage?.stale)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle className="context-usage-track" cx="12" cy="12" r="8" />
            {percent !== undefined ? (
              <circle
                className="context-usage-progress"
                cx="12"
                cy="12"
                r="8"
                pathLength="100"
                strokeDasharray={`${Math.min(100, percent)} 100`}
                transform="rotate(-90 12 12)"
              />
            ) : (
              <text x="12" y="15" textAnchor="middle">
                ?
              </text>
            )}
          </svg>
        </button>
      </ControlHint>
      <dialog
        ref={dialog}
        className="project-dialog context-usage-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
      >
        <div className="project-dialog-heading">
          <h2 id={titleId}>{t('settings:context_title')}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings:context_close')}
            onClick={() => setExpanded(false)}
          >
            <Icon name="close" size={17} />
          </Button>
        </div>
        <p className="context-usage-status">
          {status}
          {percent !== undefined && ` · ${percentLabel}`}
        </p>
        <UsageDetails usage={usage} />
        <p className="context-usage-note">{t('settings:context_note')}</p>
        {usage && (
          <p className="context-usage-note">
            {t('settings:context_report', {
              model: usage.model ?? t('common:not_reported'),
            })}
          </p>
        )}
        <p className="context-usage-note">{t('settings:context_history')}</p>
        <div className="project-dialog-actions">
          {usage && (
            <time dateTime={new Date(usage.reportedAt).toISOString()}>
              {t('settings:context_updated', {
                time: formatDate(new Date(usage.reportedAt), {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }),
              })}
            </time>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={offline || refreshing}
            onClick={() => {
              setRefreshing(true);
              setError(false);
              void onRefresh()
                .catch(() => setError(true))
                .finally(() => setRefreshing(false));
            }}
          >
            <Icon name="refresh" size={14} />
            {refreshing ? t('common:loading_2') : t('settings:context_refresh')}
          </Button>
        </div>
        {error && <p role="alert">{t('settings:context_refresh_error')}</p>}
      </dialog>
    </>
  );
}

import { t, formatNumber } from '../i18n';
import type { SessionTokenUsage } from '../../shared/types';
import { contextUsagePercent, contextUsageStatus, formatTokenCount } from '../lib/context-usage';
import { ControlHint } from './ControlHint';

export function ContextUsage({ usage, offline }: { usage?: SessionTokenUsage; offline: boolean }) {
  const percent = contextUsagePercent(usage);
  const used = usage?.invalidated ? undefined : usage?.last?.totalTokens;
  return (
    <ControlHint
      toggleOnClick
      content={
        <>
          <span>
            {t('settings:context_usage', {
              used: formatTokenCount(used),
              limit: formatTokenCount(
                usage?.invalidated === 'modelChanged' ? undefined : usage?.modelContextWindow,
              ),
            })}
            {percent !== undefined && ` · ${formatNumber(percent, { maximumFractionDigits: 0 })}%`}
          </span>
          {usage && (offline || usage.stale || usage.invalidated) && (
            <span>{contextUsageStatus(usage, offline)}</span>
          )}
        </>
      }
    >
      <button
        type="button"
        className="context-usage-trigger"
        aria-label={t('settings:context_trigger')}
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
  );
}

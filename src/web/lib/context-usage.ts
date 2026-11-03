import { t, formatNumber } from '../i18n';
import type { SessionTokenUsage } from '../../shared/types';

/** This is the last reported response footprint, never the session's cumulative consumption. */
export function contextUsagePercent(usage?: SessionTokenUsage): number | undefined {
  const used = usage?.last?.totalTokens;
  const window = usage?.modelContextWindow;
  if (
    usage?.stale ||
    usage?.invalidated ||
    used === undefined ||
    window == null ||
    window <= 0 ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isSafeInteger(window)
  )
    return undefined;
  return (used / window) * 100;
}

export function contextUsageStatus(usage?: SessionTokenUsage, offline = false): string {
  if (!usage) return t('settings:context_not_reported');
  if (offline || usage.stale) return t('settings:context_stale');
  if (usage.invalidated === 'compaction') return t('settings:context_compaction');
  if (usage.invalidated === 'modelChanged') return t('settings:context_modelChanged');
  return t('settings:context_recent');
}

/** Decimal K/M/B units shared by context and per-turn usage. */
export function formatTokenCount(value?: number | null): string {
  if (value == null || !Number.isSafeInteger(value) || value < 0) return t('common:not_reported');
  const unit =
    value >= 999_950_000
      ? ([1e9, 'B'] as const)
      : value >= 999_950
        ? ([1e6, 'M'] as const)
        : value >= 1e3
          ? ([1e3, 'K'] as const)
          : ([1, ''] as const);
  return `${formatNumber(value / unit[0], { maximumFractionDigits: unit[0] === 1 ? 0 : 1 })}${unit[1]}`;
}

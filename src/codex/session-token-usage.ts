import type { SessionTokenUsage, TokenUsageBreakdown } from '../shared/types.js';

const fields = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const;

function breakdown(value: unknown): TokenUsageBreakdown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: TokenUsageBreakdown = {};
  for (const field of fields) {
    const count = (value as Record<string, unknown>)[field];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      result[field] = count;
  }
  return result;
}

/** Preserve missing vs null vs zero, whitelist fields, and never fill gaps from a previous report. */
export function mapSessionTokenUsage(value: unknown, turnId: string): SessionTokenUsage {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const window = raw.modelContextWindow;
  return {
    total: breakdown(raw.total),
    last: breakdown(raw.last),
    ...(window === null ||
    (typeof window === 'number' && Number.isSafeInteger(window) && window >= 0)
      ? { modelContextWindow: window }
      : {}),
    turnId,
    reportedAt: Date.now(),
  };
}

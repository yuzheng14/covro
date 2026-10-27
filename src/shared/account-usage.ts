/** Read-only account quotas, deliberately separate from thread token usage. */
export interface UsageWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface UsageGroup {
  limitId: string | null;
  limitName: string | null;
  normalModelSlug: string | null;
  planType: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  individualLimit: {
    limit: string | null;
    used: string | null;
    remainingPercent: number | null;
    resetsAt: number | null;
  } | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: string | null;
}

export interface AccountUsage {
  /** Changes on account or process invalidation; contains no account identifier. */
  scope: string;
  status: 'loading' | 'ready' | 'signedOut' | 'unsupported' | 'error' | 'offline';
  refreshing: boolean;
  updatedAt: number | null;
  groups: UsageGroup[];
  ordinaryUsageAllowed: boolean | null;
  resetCreditsAvailable: number | null;
}

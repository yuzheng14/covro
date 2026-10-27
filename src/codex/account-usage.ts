import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.js';
import type { AccountUsage, UsageGroup } from '../shared/account-usage.js';
import { CodexError, isRecord } from './transport.js';

const nullable = <T extends z.ZodType>(value: T) => value.nullish().transform((v) => v ?? null);
const text = nullable(z.string());
const number = nullable(z.number().finite());
const boolean = nullable(z.boolean());
const timestamp = nullable(z.number().finite().min(0).max(8.64e12));
const window = nullable(
  z.object({
    usedPercent: number,
    windowDurationMins: nullable(z.number().finite().nonnegative()),
    resetsAt: timestamp,
  }),
);
const group = z.object({
  limitId: text,
  limitName: text,
  normalModelSlug: text,
  planType: text,
  primary: window,
  secondary: window,
  credits: nullable(z.object({ hasCredits: boolean, unlimited: boolean, balance: text })),
  individualLimit: nullable(
    z.object({
      limit: text,
      used: text,
      remainingPercent: number,
      resetsAt: timestamp,
    }),
  ),
  spendControlReached: boolean,
  rateLimitReachedType: text,
});
const response = z.object({
  rateLimits: nullable(group),
  rateLimitsByLimitId: nullable(z.record(z.string(), group)),
  ordinaryUsageAllowed: boolean,
  rateLimitResetCredits: nullable(
    z.object({ availableCount: nullable(z.number().int().nonnegative()) }),
  ),
});

export function accountUsageValues(input: unknown) {
  const value = response.parse(input);
  const groups: UsageGroup[] = Object.entries(value.rateLimitsByLimitId ?? {}).map(
    ([id, entry]) => ({ ...entry, limitId: entry.limitId ?? id }),
  );
  // The legacy bucket mirrors a map entry. Keep it only when it adds a distinct bucket.
  if (
    value.rateLimits &&
    (!groups.length ||
      (value.rateLimits.limitId !== null &&
        !groups.some((entry) => entry.limitId === value.rateLimits?.limitId)))
  ) {
    groups.unshift(value.rateLimits);
  }
  return {
    groups,
    ordinaryUsageAllowed: value.ordinaryUsageAllowed,
    resetCreditsAvailable: value.rateLimitResetCredits?.availableCount ?? null,
  };
}

/** Owns freshness and identity boundaries. Sparse notifications trigger a full read. */
export class AccountUsageReader {
  private sequence = 0;
  private identity?: string;
  private value: AccountUsage = this.empty('offline');
  constructor(
    private readonly source: {
      account: () => Promise<GetAccountResponse>;
      limits: () => Promise<unknown>;
      changed: () => void;
      authenticated: (value: boolean) => void;
    },
  ) {}

  snapshot(): AccountUsage {
    return structuredClone(this.value);
  }

  private empty(status: AccountUsage['status']): AccountUsage {
    return {
      scope: randomUUID(),
      status,
      refreshing: false,
      updatedAt: null,
      groups: [],
      ordinaryUsageAllowed: null,
      resetCreditsAvailable: null,
    };
  }

  invalidate(status: 'offline' | 'loading'): void {
    this.sequence++;
    this.identity = undefined;
    this.value = this.empty(status);
    this.source.changed();
  }

  async refresh(): Promise<AccountUsage> {
    const sequence = ++this.sequence;
    this.value = { ...this.value, refreshing: true };
    this.source.changed();
    try {
      const result = await this.source.account();
      if (sequence !== this.sequence) return this.snapshot();
      if (
        !isRecord(result) ||
        !Object.hasOwn(result, 'account') ||
        typeof result.requiresOpenaiAuth !== 'boolean'
      )
        throw new Error('Invalid account response');
      const identity = JSON.stringify(result.account);
      if (this.identity !== undefined && identity !== this.identity) {
        this.value = this.empty('loading');
        this.source.changed();
      }
      this.identity = identity;
      this.source.authenticated(result.account !== null || !result.requiresOpenaiAuth);
      if (!result.account) {
        this.value = {
          ...this.empty(result.requiresOpenaiAuth ? 'signedOut' : 'unsupported'),
          scope: this.value.scope,
        };
      } else if (result.account.type !== 'chatgpt') {
        this.value = { ...this.empty('unsupported'), scope: this.value.scope };
      } else {
        const values = accountUsageValues(await this.source.limits());
        if (sequence !== this.sequence) return this.snapshot();
        this.value = {
          ...this.value,
          ...values,
          status: 'ready',
          refreshing: false,
          updatedAt: Date.now(),
        };
      }
    } catch (error) {
      if (sequence !== this.sequence) return this.snapshot();
      const unsupported =
        error instanceof CodexError &&
        (error.rpcCode === -32601 || error.code === 'PROTOCOL_INCOMPATIBLE');
      this.value = unsupported
        ? { ...this.empty('unsupported'), scope: this.value.scope }
        : { ...this.value, status: 'error', refreshing: false };
    }
    if (sequence === this.sequence) this.source.changed();
    return this.snapshot();
  }
}

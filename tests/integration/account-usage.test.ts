import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountUsageReader, accountUsageValues } from '../../src/codex/account-usage';
import { CodexAdapter, CodexError } from '../../src/codex/adapter';
import { resolve } from 'node:path';
import type { GetAccountResponse } from '../../src/codex/generated/v2/GetAccountResponse';
import type { SimulatorOptions } from '../fixtures/app-server';

const chatgpt: GetAccountResponse = {
  account: { type: 'chatgpt', email: 'private@example.test', planType: 'plus' },
  requiresOpenaiAuth: true,
};
const limits = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 1 } },
  ordinaryUsageAllowed: false,
  accountId: 'private-account-id',
  rateLimitUpsell: { secret: 'not-for-ui' },
};
function reader(account = chatgpt) {
  const source = {
    account: vi.fn(async () => account),
    limits: vi.fn(async (): Promise<unknown> => limits),
    changed: vi.fn(),
    authenticated: vi.fn(),
  };
  return { source, reader: new AccountUsageReader(source) };
}
const adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.stop()));
});
async function fixture(options: SimulatorOptions) {
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ accountResponse: chatgpt, ...options }),
    ],
  });
  adapters.push(adapter);
  await adapter.start();
  await adapter.refreshAccountUsage();
  return adapter;
}

describe('account quota snapshots', () => {
  it('keeps distinct buckets, avoids the legacy duplicate, strips private fields and preserves nulls', () => {
    const values = accountUsageValues({
      ...limits,
      rateLimitsByLimitId: {
        codex: limits.rateLimits,
        model: { limitName: 'Model quota', credits: { unlimited: true }, secondary: {} },
      },
    });
    expect(values.groups).toHaveLength(2);
    expect(values.groups[0]?.primary).toEqual({
      usedPercent: 100,
      resetsAt: 1,
      windowDurationMins: null,
    });
    expect(values.groups[1]).toMatchObject({
      limitId: 'model',
      limitName: 'Model quota',
      credits: { unlimited: true, balance: null, hasCredits: null },
      secondary: { usedPercent: null },
    });
    expect(JSON.stringify(values)).not.toMatch(/private|secret|accountId|rateLimitUpsell/);
    expect(accountUsageValues({}).groups).toEqual([]);
    expect(accountUsageValues({ rateLimits: {}, rateLimitsByLimitId: {} }).groups).toHaveLength(1);
    expect(() => accountUsageValues({ rateLimits: { primary: { usedPercent: '25' } } })).toThrow();
  });
  it('reports a stale snapshot on refresh error without inferring recovery at reset time', async () => {
    const { source, reader: usage } = reader();
    const current = await usage.refresh();
    source.limits.mockRejectedValue(new Error('private diagnostic'));
    const failed = await usage.refresh();
    expect(failed).toMatchObject({
      status: 'error',
      updatedAt: current.updatedAt,
      groups: current.groups,
      ordinaryUsageAllowed: false,
    });
    expect(JSON.stringify(failed)).not.toContain('private');
  });
  it.each([
    [{ account: null, requiresOpenaiAuth: true }, 'signedOut'],
    [{ account: null, requiresOpenaiAuth: false }, 'unsupported'],
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, 'unsupported'],
    [
      {
        account: { type: 'amazonBedrock', usesCodexManagedCredentials: false },
        requiresOpenaiAuth: false,
      },
      'unsupported',
    ],
  ] as const)('handles account state %j', async (account, status) => {
    const { source, reader: usage } = reader(account);
    expect(await usage.refresh()).toMatchObject({ status, groups: [], updatedAt: null });
    expect(source.limits).not.toHaveBeenCalled();
  });
  it('clears an account change before its slow read completes and discards old responses', async () => {
    const { source, reader: usage } = reader();
    await usage.refresh();
    let finish!: (value: unknown) => void;
    source.limits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stale = usage.refresh();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const oldScope = usage.snapshot().scope;
    usage.invalidate('loading');
    expect(usage.snapshot()).toMatchObject({ groups: [], updatedAt: null });
    expect(usage.snapshot().scope).not.toBe(oldScope);
    source.account.mockResolvedValue({
      ...chatgpt,
      account: { type: 'chatgpt', email: 'new@example.test', planType: 'pro' },
    });
    source.limits.mockResolvedValue({ rateLimits: { limitName: 'new account' } });
    await usage.refresh();
    finish(limits);
    await stale;
    expect(usage.snapshot().groups[0]?.limitName).toBe('new account');
    usage.invalidate('offline');
    expect(usage.snapshot()).toMatchObject({ status: 'offline', groups: [], updatedAt: null });
  });
  it('clears data when a manual read discovers a different account, even if the quota request fails', async () => {
    const { source, reader: usage } = reader();
    await usage.refresh();
    source.account.mockResolvedValue({
      ...chatgpt,
      account: { type: 'chatgpt', email: null, planType: 'plus' },
    });
    source.limits.mockRejectedValue(new Error('failed'));
    expect(await usage.refresh()).toMatchObject({ status: 'error', groups: [], updatedAt: null });
  });
  it('distinguishes unsupported RPC from an upstream failure', async () => {
    const { source, reader: usage } = reader();
    source.limits.mockRejectedValue(
      new CodexError('PROTOCOL_INCOMPATIBLE', 'Method not found', false, -32601),
    );
    expect(await usage.refresh()).toMatchObject({ status: 'unsupported', groups: [] });
  });
});

describe('quota RPC in the native adapter', () => {
  it('serves normal Codex work while an optional quota read is pending', async () => {
    const adapter = new CodexAdapter({
      binary: process.execPath,
      args: [
        '--import',
        'tsx',
        resolve('tests/fixtures/app-server.ts'),
        '--options',
        JSON.stringify({ accountResponse: chatgpt, rateLimitHang: true }),
      ],
    });
    adapters.push(adapter);
    await adapter.start();
    expect(adapter.ready).toBe(true);
    expect(adapter.diagnostics().accountUsage).toMatchObject({
      status: 'loading',
      refreshing: true,
    });
    expect(await adapter.listThreads('/tmp')).toMatchObject({ data: [] });
  });
  it('reads limits and refetches sparse notifications without losing another bucket', async () => {
    const adapter = await fixture({
      rateLimitResponses: [
        limits,
        {
          ...limits,
          rateLimitsByLimitId: {
            codex: { ...limits.rateLimits, primary: { usedPercent: 25 } },
            other: { limitName: 'Other model' },
          },
        },
      ],
      rateLimitNotification: 'limits',
    });
    await expect.poll(() => adapter.diagnostics().accountUsage?.groups.length).toBe(2);
    expect(adapter.diagnostics().accountUsage?.groups[0]?.primary?.usedPercent).toBe(25);
    expect(JSON.stringify(adapter.diagnostics())).not.toContain('private');
  });
  it('re-reads account updates and clears data when signed out', async () => {
    const adapter = await fixture({
      rateLimitResponses: [limits],
      rateLimitNotification: 'account',
      accountAfterNotification: { account: null, requiresOpenaiAuth: true },
    });
    await expect.poll(() => adapter.diagnostics().accountUsage?.status).toBe('signedOut');
    expect(adapter.diagnostics()).toMatchObject({
      authenticated: false,
      accountUsage: { groups: [], updatedAt: null },
    });
  });
  it('keeps the app-server ready when quotas are unsupported or fail', async () => {
    for (const options of [
      { unsupportedMethod: 'account/rateLimits/read' },
      { rateLimitFailure: true },
    ]) {
      const adapter = await fixture(options);
      expect(adapter.ready).toBe(true);
      expect(adapter.diagnostics().accountUsage?.status).toBe(
        options.rateLimitFailure ? 'error' : 'unsupported',
      );
    }
  });
});

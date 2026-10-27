import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(options: SimulatorOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-review-adapter-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ ...options, logPath }),
    ],
  });
  cleanup.push(() => adapter.stop());
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  const thread = await adapter.createThread(dir);
  return {
    adapter,
    thread,
    events,
    requests: async () =>
      (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: unknown }),
  };
}

describe('review/start protocol adapter', () => {
  it('uses a native inline uncommitted review, projects results, and never sends a user prompt', async () => {
    const { adapter, thread, events, requests } = await setup();
    expect(adapter.diagnostics().capabilities).toContain('review/start');
    const turn = await adapter.startReview(thread.id);
    expect(turn).toMatchObject({
      threadId: thread.id,
      status: 'running',
      items: [{ type: 'enteredReviewMode', text: '未提交改动' }],
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn',
          turn: expect.objectContaining({ id: turn.id, status: 'completed' }),
        }),
      ),
    );
    const history = await adapter.readThread(thread.id);
    expect(history.turns[0]!.items).toContainEqual(
      expect.objectContaining({
        type: 'exitedReviewMode',
        text: expect.stringContaining('代码审查结果'),
      }),
    );
    expect(history.turns[0]!.items.some((item) => item.type === 'userMessage')).toBe(false);
    const calls = await requests();
    expect(calls.filter((entry) => entry.method === 'review/start')).toEqual([
      {
        id: expect.any(Number),
        method: 'review/start',
        params: { threadId: thread.id, target: { type: 'uncommittedChanges' }, delivery: 'inline' },
      },
    ]);
    expect(calls.some((entry) => entry.method === 'turn/start')).toBe(false);
  });

  it('routes native review approval through the existing request and response machinery', async () => {
    const { adapter, thread, events } = await setup({ approval: 'command' });
    const turn = await adapter.startReview(thread.id);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'action')).toBe(true));
    const action = events.find((event) => event.type === 'action');
    if (action?.type !== 'action') throw new Error('Expected review approval');
    expect(action.action).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      status: 'pending',
    });
    await adapter.respond(action.action.actionId, { decision: 'accept' });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === 'turn' && event.turn.status === 'completed'),
      ).toBe(true),
    );
  });

  it('reports a definite native review failure without inventing a turn', async () => {
    const { adapter, thread, events } = await setup({ reviewFailure: 'Not a Git repository' });
    await expect(adapter.startReview(thread.id)).rejects.toMatchObject({
      message: 'Not a Git repository',
      uncertain: false,
    });
    expect(events.some((event) => event.type === 'turn')).toBe(false);
    expect((await adapter.readThread(thread.id)).turns).toHaveLength(0);
  });

  it.each([{ reviewWrongThread: true }, { malformedTurnReceipt: true }])(
    'treats malformed native receipts as uncertain: %j',
    async (options) => {
      const { adapter, thread } = await setup(options);
      await expect(adapter.startReview(thread.id)).rejects.toMatchObject({
        code: 'PROTOCOL_INCOMPATIBLE',
        uncertain: true,
      });
    },
  );

  it('removes an unsupported native review capability and reports definite upstream rejection', async () => {
    const { adapter, thread } = await setup({ unsupportedMethod: 'review/start' });
    await expect(adapter.startReview(thread.id)).rejects.toMatchObject({
      rpcCode: -32601,
      uncertain: false,
    });
    expect(adapter.diagnostics().capabilities).not.toContain('review/start');
    await expect(adapter.startReview(thread.id)).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      uncertain: false,
    });
  });
});

it('forwards every native review target including commit title null', async () => {
  const { adapter, thread, events, requests } = await setup();
  const targets = [
    { type: 'baseBranch', branch: 'main' },
    { type: 'commit', sha: 'abcdef123' },
    { type: 'custom', instructions: 'Check authorization' },
  ] as const;
  for (const target of targets) {
    const turn = await adapter.startReview(thread.id, target);
    await vi.waitFor(() =>
      expect(
        events.some(
          (e) => e.type === 'turn' && e.turn.id === turn.id && e.turn.status === 'completed',
        ),
      ).toBe(true),
    );
  }
  expect(
    (await requests())
      .filter((r) => r.method === 'review/start')
      .map((r) => (r.params as { target: unknown }).target),
  ).toEqual([targets[0], { ...targets[1], title: null }, targets[2]]);
});

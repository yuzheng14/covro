import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter';
import { settingsSchema } from '../../src/shared/validation';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('sends a native Plan preset, confirms mode through events, and restores it on resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'covro-plan-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ logPath, turnDelayMs: 10 }),
    ],
  });
  cleanup.push(() => adapter.stop());
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  const thread = await adapter.createThread(dir);
  const turn = await adapter.startTurn(thread.id, dir, 'Compare options', {
    collaborationMode: 'plan',
  });
  await vi.waitFor(() =>
    expect(
      events.some(
        (e) => e.type === 'turn' && e.turn.id === turn.id && e.turn.status === 'completed',
      ),
    ).toBe(true),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'threadSettings',
      settings: expect.objectContaining({ collaborationMode: 'plan' }),
    }),
  );
  expect((await adapter.resumeThread(thread.id, dir)).runtimeSettings?.collaborationMode).toBe(
    'plan',
  );
  await adapter.startTurn(thread.id, dir, 'Implement the plan', { collaborationMode: 'default' });
  const calls = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const starts = calls.filter(
    (call) => call.method === 'turn/start' && call.params.threadId === thread.id,
  );
  expect(starts.map((call) => call.params.collaborationMode)).toEqual([
    {
      mode: 'plan',
      settings: {
        model: thread.runtimeSettings!.model,
        reasoning_effort: thread.runtimeSettings!.reasoningEffort,
        developer_instructions: null,
      },
    },
    {
      mode: 'default',
      settings: {
        model: thread.runtimeSettings!.model,
        reasoning_effort: thread.runtimeSettings!.reasoningEffort,
        developer_instructions: null,
      },
    },
  ]);
  expect(calls.some((call) => call.method === 'config/batchWrite')).toBe(false);
});

it('accepts only built-in collaboration presets', () => {
  expect(settingsSchema.parse({ collaborationMode: 'plan' })).toEqual({
    collaborationMode: 'plan',
  });
  expect(
    settingsSchema.safeParse({ collaborationMode: 'custom', developer_instructions: 'override' })
      .success,
  ).toBe(false);
});

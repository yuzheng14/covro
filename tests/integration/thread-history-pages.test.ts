import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { GatewayService } from '../../src/server/service.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('opens a long session with one native page, resumes without a full read, and pages to the end', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  const logPath = join(resource.directory, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        paginated: true,
        history: { turns: 125, itemsPerTurn: 2, itemBytes: 500 },
        logPath,
      }),
    ],
  });
  cleanups.push(() => adapter.stop());
  await adapter.start();
  const created = await adapter.createThread(resource.project);
  const service = new GatewayService({
    store: resource.store,
    projects: resource.projects,
    codex: adapter,
  });
  const recent = await service.getThread(created.id);
  expect(recent.turns).toHaveLength(12);
  expect(recent.history?.olderCursor).toBeTruthy();
  const requests = () =>
    readFile(logPath, 'utf8').then((text) =>
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }),
    );
  const opening = await requests();
  expect(opening.filter((r) => r.method === 'thread/turns/list')).toHaveLength(1);
  expect(opening.some((r) => r.method === 'thread/read' && r.params?.includeTurns === true)).toBe(
    false,
  );
  const resumed = await adapter.resumeThread(created.id, resource.project);
  expect(resumed.turns).toHaveLength(12);
  const ids = recent.turns.map((turn) => turn.id);
  let cursor = recent.history!.olderCursor;
  while (cursor) {
    const page = await service.getThreadHistory(created.id, cursor);
    expect(page.turns.length).toBeLessThanOrEqual(12);
    ids.unshift(...page.turns.map((turn) => turn.id));
    cursor = page.history!.olderCursor;
  }
  expect(ids).toHaveLength(125);
  expect(new Set(ids).size).toBe(125);
  const full = await adapter.readThread(created.id);
  expect(ids).toEqual(full.turns.map((turn) => turn.id));
  await expect(
    adapter.readThreadPage('another-thread', recent.history!.olderCursor!),
  ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_EXPIRED' });
  // Reading older pages must never displace live control state or inflate websocket snapshots.
  expect((await service.getThread(created.id)).turns).toHaveLength(12);
});

it('hydrates item-summary pages and retains the legacy history fallback', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  for (const paginated of [true, false]) {
    const logPath = join(resource.directory, `history-${paginated}.jsonl`);
    const adapter = new CodexAdapter({
      binary: process.execPath,
      args: [
        '--import',
        'tsx',
        resolve('tests/fixtures/app-server.ts'),
        '--options',
        JSON.stringify({
          paginated,
          logPath,
          historyItemSummaries: true,
          historyPageSize: 2,
          history: { turns: 5, itemsPerTurn: 3, itemBytes: 10 },
        }),
      ],
    });
    cleanups.push(() => adapter.stop());
    await adapter.start();
    const created = await adapter.createThread(resource.project);
    const page = await adapter.readThreadPage(created.id);
    expect(page.turns).toHaveLength(paginated ? 2 : 5);
    expect(page.turns.every((turn) => turn.items.length >= 3)).toBe(true);
    expect(Boolean(page.history?.olderCursor)).toBe(paginated);
    if (!paginated) {
      const reads = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method?: string; params?: { includeTurns: boolean } })
        .filter((request) => request.method === 'thread/read');
      expect(reads.map((request) => request.params?.includeTurns)).toEqual([false, true]);
    }
  }
});

it('bounds a warm snapshot and resumes history before its oldest visible turn', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  const logPath = join(resource.directory, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        paginated: true,
        history: { turns: 37, itemsPerTurn: 3, itemBytes: 1000 },
        logPath,
      }),
    ],
  });
  cleanups.push(() => adapter.stop());
  await adapter.start();
  const source = await adapter.createThread(resource.project);
  const service = new GatewayService({
    store: resource.store,
    projects: resource.projects,
    codex: adapter,
  });
  const initial = await service.getThread(source.id);
  const full = await adapter.readThread(source.id);
  service.projection.thread({ ...initial, managed: true, turns: full.turns });

  const { data } = await service.getThreadSnapshot(source.id);
  expect(data.turns.map((turn) => turn.id)).toEqual(full.turns.slice(-12).map((turn) => turn.id));
  const ids = data.turns.map((turn) => turn.id);
  let cursor = data.history?.olderCursor;
  while (cursor) {
    const page = await service.getThreadHistory(source.id, cursor);
    expect(page.turns.length).toBeLessThanOrEqual(12);
    ids.unshift(...page.turns.map((turn) => turn.id));
    cursor = page.history?.olderCursor;
  }
  expect(ids).toEqual(full.turns.map((turn) => turn.id));

  const prior = await readFile(logPath, 'utf8');
  const latest = full.turns.at(-1)!;
  const evidence = await adapter.readExecutionHistory(source.id, latest.id);
  const requests = (await readFile(logPath, 'utf8')).slice(prior.length);
  expect(evidence.turns.at(-1)).toMatchObject({ id: latest.id, status: latest.status, items: [] });
  expect(requests).toContain('"itemsView":"notLoaded"');
  expect(requests).not.toContain('thread/items/list');
});

it('pages the history of a new paginated fork', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ paginated: true, history: { turns: 19, itemsPerTurn: 1, itemBytes: 10 } }),
    ],
  });
  cleanups.push(() => adapter.stop());
  await adapter.start();
  const source = await adapter.createThread(resource.project);
  const fork = await adapter.forkThread(source.id, resource.project, undefined, {
    recentOnly: true,
  });
  expect(fork).toMatchObject({ historyMode: 'paginated', forkedFromId: source.id });
  expect(fork.turns).toHaveLength(12);
  expect(fork.history?.olderCursor).toBeTruthy();
});

it('keeps saved tool output out of a paginated snapshot and reads it by item', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  const codex = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        codexVersion: '0.172.0',
        paginated: true,
        history: { turns: 18, itemsPerTurn: 1, itemBytes: 4000 },
      }),
    ],
  });
  cleanups.push(() => codex.stop());
  await codex.start();
  const source = await codex.createThread(resource.project);
  const service = new GatewayService({ store: resource.store, projects: resource.projects, codex });
  const snapshot = await service.getThreadSnapshot(source.id);
  const turn = snapshot.data.turns.at(-1)!;
  const tool = turn.items[0]!;
  expect(tool).toMatchObject({ type: 'commandExecution', output: '', outputDeferred: true });
  expect(await service.getThreadItem(source.id, turn.id, tool.id)).toMatchObject({
    id: tool.id,
    output: 'x'.repeat(4000),
  });
  await expect(service.getThreadItem(source.id, turn.id, 'missing')).rejects.toMatchObject({
    code: 'THREAD_ITEM_NOT_FOUND',
  });
  const full = await codex.readThread(source.id);
  expect(full.turns.at(-1)?.items[0]).toMatchObject({ output: 'x'.repeat(4000) });
});

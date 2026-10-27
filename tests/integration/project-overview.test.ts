import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../../src/server/service.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { toThreadSummary } from '../../src/shared/thread-summary.js';
import type { PendingAction, ServerMessage, ThreadPage } from '../../src/shared/types.js';
import { databaseHarness } from './domain-db-helpers.js';
import { deferred, DomainCodex, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof databaseHarness>[] = [];
function setup() {
  const database = databaseHarness();
  resources.push(database);
  const first = join(database.directory, 'first');
  const second = join(database.directory, 'second');
  const outside = join(database.directory, 'outside');
  for (const directory of [first, second, outside, join(database.directory, 'web')])
    mkdirSync(directory);
  const registered = [
    { id: 'first', name: 'First', path: first },
    { id: 'second', name: 'Second', path: second },
    { id: 'missing', name: 'Unavailable', path: join(database.directory, 'missing') },
  ];
  const projects = new ProjectRegistry(registered);
  const codex = new DomainCodex();
  const service = new GatewayService({ store: database.store, projects, codex });
  const config = parseConfig(
    { projects: registered, dataDir: join(database.directory, 'data') },
    join(database.directory, 'config.json'),
  );
  const app = createApp({ config, service, staticDir: join(database.directory, 'web') });
  return { ...database, first, second, outside, projects, codex, service, app };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});
async function create(service: GatewayService, projectId: string) {
  const operation = await service.createThread(projectId, { clientOperationId: operationId() });
  return (operation.result as { threadId: string }).threadId;
}
function approval(threadId: string, turnId: string): PendingAction {
  return {
    actionId: `approval-${threadId}`,
    codexEpoch: 'epoch-one',
    rpcId: 1,
    threadId,
    turnId,
    kind: 'command',
    status: 'pending',
    title: 'Sensitive approval title',
    command: 'cat private-key',
    options: [{ id: 'accept', label: 'Allow' }],
    details: { secret: 'sensitive control payload' },
  };
}

describe('project conversation overview', () => {
  it('identifies completions by turn ID across renames and repeated update timestamps', async () => {
    const { service, codex, first } = setup();
    const overview: ServerMessage[] = [];
    service.subscribeOverview((event) => overview.push(event));
    const id = await create(service, 'first');
    codex.threads.get(id)!.updatedAt = 123;
    service.projection.get(id)!.updatedAt = 123;
    const noTurns = toThreadSummary(service.projection.get(id)!);
    expect(noTurns).not.toHaveProperty('lastTurnId');
    expect(noTurns).not.toHaveProperty('lastTurnStatus');

    await service.startTurn(id, { clientOperationId: operationId(), text: 'first completion' });
    codex.complete(id, 'turn-1');
    expect(overview.at(-1)).toMatchObject({
      payload: { lastTurnId: 'turn-1', lastTurnStatus: 'completed', updatedAt: 123 },
    });
    await service.renameThread(id, { clientOperationId: operationId(), name: 'Renamed' });
    expect(overview.at(-1)).toMatchObject({
      payload: { title: 'Renamed', lastTurnId: 'turn-1', lastTurnStatus: 'completed' },
    });
    expect((await service.listThreadSummaries('first')).data[0]).toMatchObject({
      lastTurnId: 'turn-1',
      lastTurnStatus: 'completed',
      updatedAt: 123,
    });

    await service.startTurn(id, { clientOperationId: operationId(), text: 'second completion' });
    codex.complete(id, 'turn-2');
    expect(overview.at(-1)).toMatchObject({
      payload: { lastTurnId: 'turn-2', lastTurnStatus: 'completed', updatedAt: 123 },
    });

    // Metadata-only history cannot establish a completed turn from the thread timestamp.
    codex.threads.set('unloaded-history', {
      ...threadView('unloaded-history', first),
      updatedAt: 456,
    });
    const unloaded = (await service.listThreadSummaries('first')).data.find(
      (entry) => entry.id === 'unloaded-history',
    );
    expect(unloaded).toMatchObject({ updatedAt: 456 });
    expect(unloaded).not.toHaveProperty('lastTurnId');
    expect(unloaded).not.toHaveProperty('lastTurnStatus');
  });

  it('retains the creator through metadata refreshes, projection updates and summary broadcasts', async () => {
    const { service, codex, first, app } = setup();
    const originator = 'codex_web_ui';
    const thread = { ...threadView('web-created', first), source: 'vscode', originator };
    codex.threads.set(thread.id, thread);
    const overview: ServerMessage[] = [];
    service.subscribeOverview((event) => overview.push(event));
    codex.emit({ type: 'thread', thread });
    const identity = { id: thread.id, source: 'vscode', originator };
    expect(overview.at(-1)).toMatchObject({ kind: 'threadSummary', payload: identity });
    expect((await service.listThreadSummaries('first')).data).toContainEqual(
      expect.objectContaining(identity),
    );

    await service.getThread(thread.id);
    codex.emit({ type: 'threadName', threadId: thread.id, name: 'Renamed thread' });
    codex.emit({ type: 'threadStatus', threadId: thread.id, status: 'running' });
    expect(service.projection.get(thread.id)).toMatchObject({
      ...identity,
      title: 'Renamed thread',
      status: 'running',
    });
    expect(overview.at(-1)).toMatchObject({ payload: { ...identity, status: 'running' } });
    expect(
      await (await app.request(`http://127.0.0.1:8787/api/threads/${thread.id}`)).json(),
    ).toMatchObject(identity);
  });

  it('reports other projects, new forks and approvals without subscribing to their content', async () => {
    const { service, codex } = setup();
    const first = await create(service, 'first');
    const selected: ServerMessage[] = [];
    const stopSelected = await service.subscribe(first, undefined, (event) => selected.push(event));
    const overview: ServerMessage[] = [];
    const stopOverview = service.subscribeOverview((event) => overview.push(event));
    const second = await create(service, 'second');
    expect(overview.at(-1)).toMatchObject({
      kind: 'threadSummary',
      threadId: second,
      payload: { id: second, projectId: 'second', managed: true, pendingActionCount: 0 },
    });
    await service.startTurn(second, { clientOperationId: operationId(), text: 'secret prompt' });
    codex.emit({ type: 'action', action: approval(second, 'turn-1') });
    expect(
      overview.findLast((event) => event.type === 'event' && event.kind === 'threadSummary'),
    ).toMatchObject({
      kind: 'threadSummary',
      payload: {
        status: 'waitingApproval',
        lastTurnStatus: 'waitingApproval',
        pendingActionCount: 1,
      },
    });
    const atApproval = overview.length;
    for (let i = 0; i < 10; i++)
      codex.emit({
        type: 'delta',
        threadId: second,
        turnId: 'turn-1',
        itemId: 'agent',
        field: 'text',
        delta: 'secret model output',
        itemType: 'agentMessage',
      });
    expect(overview).toHaveLength(atApproval);
    codex.complete(second, 'turn-1');
    expect(overview.at(-1)).toMatchObject({
      payload: { status: 'completed', lastTurnStatus: 'completed', pendingActionCount: 0 },
    });
    codex.emit({ type: 'threadStatus', threadId: second, status: 'idle' });
    expect(overview.at(-1)).toMatchObject({
      payload: { status: 'idle', lastTurnStatus: 'completed' },
    });
    await service.forkThread(second, { clientOperationId: operationId() });
    expect(overview.at(-1)).toMatchObject({
      payload: { id: 'fork-1', forkedFromId: second, projectId: 'second', managed: true },
    });
    const encoded = JSON.stringify(overview);
    for (const forbidden of [
      'secret prompt',
      'secret model output',
      'private-key',
      'details',
      'cwd',
      'turns',
      'actions',
      'execution',
    ])
      expect(encoded).not.toContain(forbidden);
    expect(
      selected.filter((event) => event.type === 'event' && event.kind === 'threadPatch'),
    ).toEqual([]);
    expect(selected.some((event) => event.type === 'event' && event.kind === 'threadSummary')).toBe(
      false,
    );
    stopOverview();
    stopSelected();
    const beforeStop = overview.length;
    codex.emit({ type: 'threadStatus', threadId: second, status: 'running' });
    expect(overview).toHaveLength(beforeStop);
  });

  it('keeps detail replay intact and broadcasts runtime resets as unknown metadata', async () => {
    const { service, codex } = setup();
    const id = await create(service, 'first');
    const overview: ServerMessage[] = [];
    service.subscribeOverview((event) => overview.push(event));
    const cursor = service.events.cursor();
    await service.startTurn(id, { clientOperationId: operationId(), text: 'continue' });
    const runningSummary = overview.at(-1)!;
    expect(overview.at(-1)).toMatchObject({
      payload: { status: 'running', lastTurnStatus: 'running' },
    });
    codex.reset();
    expect(overview.at(-1)).toMatchObject({
      payload: { status: 'unknown', lastTurnStatus: 'unknown', managed: false },
    });
    const replay: ServerMessage[] = [];
    (await service.subscribe(id, cursor, (event) => replay.push(event)))();
    expect(replay.some((event) => event.type === 'event' && event.kind === 'threadSummary')).toBe(
      false,
    );
    expect(
      replay.filter((event) => event.type === 'event' && event.kind === 'threadPatch').length,
    ).toBeGreaterThan(0);
    expect(replay).toContainEqual(
      expect.objectContaining({
        kind: 'threadPatch',
        cursor: 'cursor' in runningSummary ? runningSummary.cursor : undefined,
        payload: expect.objectContaining({
          thread: expect.objectContaining({ status: 'running' }),
        }),
      }),
    );
    expect(replay).toContainEqual(expect.objectContaining({ kind: 'runtime' }));
  });

  it('filters foreign projects and stops overview disclosure when a registered directory disappears', async () => {
    const { service, codex, first, second, outside } = setup();
    const overview: ServerMessage[] = [];
    service.subscribeOverview((event) => overview.push(event));
    codex.emit({ type: 'thread', thread: threadView('foreign', outside) });
    codex.emit({ type: 'action', action: approval('foreign', 'foreign-turn') });
    expect(overview).toEqual([]);
    const id = await create(service, 'first');
    const count = overview.length;
    rmSync(first, { recursive: true });
    codex.emit({ type: 'threadStatus', threadId: id, status: 'running' });
    expect(overview).toHaveLength(count);
    codex.threads.set('other', threadView('other', second));
    await expect(service.listThreadSummaries('first')).rejects.toMatchObject({
      code: 'PROJECT_UNAVAILABLE',
    });
    expect((await service.listThreadSummaries('second')).data).toEqual([
      expect.objectContaining({ id: 'other', projectId: 'second' }),
    ]);
  });

  it('paginates summaries independently, checks ownership and exposes a start-of-read cursor', async () => {
    const { service, codex, first, second } = setup();
    const firstThread = threadView('first-thread', first);
    firstThread.forkedFromId = 'parent';
    firstThread.updatedAt = 123;
    firstThread.turns = [
      {
        id: 'turn',
        threadId: firstThread.id,
        status: 'completed',
        items: [{ id: 'item', type: 'userMessage', text: 'secret history' }],
      },
    ];
    const secondThread = threadView('second-thread', first);
    const foreign = threadView('foreign', second);
    const gate = deferred<ThreadPage>();
    const list = vi
      .spyOn(codex, 'listThreads')
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce({ data: [secondThread], nextCursor: null });
    const start = service.events.cursor();
    const pending = service.listThreadSummaries('first');
    codex.emit({ type: 'thread', thread: foreign });
    gate.resolve({ data: [firstThread, foreign], nextCursor: 'next-page' });
    const page = await pending;
    expect(page).toEqual({
      cursor: start,
      nextCursor: 'next-page',
      data: [
        {
          id: 'first-thread',
          archived: false,
          forkedFromId: 'parent',
          projectId: 'first',
          source: 'appServer',
          originator: null,
          title: 'first-thread',
          status: 'idle',
          managed: false,
          updatedAt: 123,
          pendingActionCount: 0,
          lastTurnId: 'turn',
          lastTurnStatus: 'completed',
          historyVisible: true,
        },
      ],
    });
    expect(page.cursor.seq).toBeLessThan(service.events.cursor().seq);
    expect(await service.listThreadSummaries('first', page.nextCursor!)).toMatchObject({
      data: [{ id: 'second-thread' }],
      nextCursor: null,
    });
    expect(list.mock.calls.map((call) => call[1])).toEqual([undefined, 'next-page']);
    expect(codex.resumes).toBe(0);
    expect(codex.starts).toBe(0);
  });

  it('counts unresolved controls without leaking their body and leaves detailed GET unchanged', async () => {
    const { service, app } = setup();
    const id = await create(service, 'first');
    const thread = service.projection.get(id)!;
    thread.actions = [
      approval(id, 'turn'),
      { ...approval(id, 'turn'), actionId: 'responding', status: 'responding' },
      { ...approval(id, 'turn'), actionId: 'expired', status: 'expired' },
      { ...approval(id, 'turn'), actionId: 'responded', status: 'responded' },
    ];
    expect(toThreadSummary(thread).pendingActionCount).toBe(2);
    const response = await app.request('http://127.0.0.1:8787/api/projects/first/threads');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ id, pendingActionCount: 2 }],
      cursor: service.events.cursor(),
    });
    const detail = await app.request(`http://127.0.0.1:8787/api/threads/${id}`);
    expect(await detail.json()).toMatchObject({
      id,
      actions: thread.actions,
      turns: [],
      cwd: thread.cwd,
    });
    const legacy = await app.request('http://127.0.0.1:8787/api/threads?projectId=first');
    expect(await legacy.json()).toMatchObject({ data: [{ id, actions: thread.actions }] });
    for (const [path, status, code] of [
      ['missing', 409, 'PROJECT_UNAVAILABLE'],
      ['unregistered', 404, 'PROJECT_NOT_FOUND'],
      ['first?cursor=', 400, 'VALIDATION_FAILED'],
    ] as const) {
      const [project, query = ''] = path.split('?');
      const result = await app.request(
        `http://127.0.0.1:8787/api/projects/${project}/threads${query ? `?${query}` : ''}`,
      );
      expect(result.status).toBe(status);
      expect(await result.json()).toMatchObject({ error: { code } });
    }
    const forbidden = await app.request('http://attacker.invalid/api/projects/first/threads');
    expect(forbidden.status).toBe(403);
  });
});

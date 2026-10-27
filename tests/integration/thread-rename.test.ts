import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { CodexError } from '../../src/codex/transport.js';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return { ...ctx, id: (created.result as { threadId: string }).threadId };
}
const input = (name = '手工名称 🧪') => ({ clientOperationId: operationId(), name });

it('renames through native metadata, publishes detail and overview, and deduplicates receipts', async () => {
  const { service, codex, store, id } = await setup();
  await service.startTurn(id, { clientOperationId: operationId(), text: 'keep running' });
  const before = structuredClone(service.projection.get(id)!);
  const marker = store.activeForThread(id);
  const overview: ServerMessage[] = [];
  const detail: ServerMessage[] = [];
  service.subscribeOverview((event) => overview.push(event));
  await service.subscribe(id, undefined, (event) => detail.push(event));
  const rename = vi.spyOn(codex, 'renameThread');
  const request = input('  手工名称 🧪  ');
  const receipt = await service.renameThread(id, request);
  expect(receipt).toMatchObject({
    status: 'acknowledged',
    result: { threadId: id, name: '手工名称 🧪' },
  });
  expect(await service.renameThread(id, request)).toEqual(receipt);
  expect(rename).toHaveBeenCalledExactlyOnceWith(id, '手工名称 🧪');
  expect(await service.getThread(id)).toMatchObject({ ...before, title: '手工名称 🧪' });
  expect((await service.listThreads('project')).data[0]?.title).toBe('手工名称 🧪');
  expect(store.activeForThread(id)).toEqual(marker);
  expect(codex.interrupts).toBe(0);
  expect(detail).toContainEqual(
    expect.objectContaining({
      kind: 'threadPatch',
      payload: expect.objectContaining({
        thread: expect.objectContaining({ id, title: '手工名称 🧪' }),
      }),
    }),
  );
  expect(overview).toContainEqual(
    expect.objectContaining({
      kind: 'threadSummary',
      payload: expect.objectContaining({ id, title: '手工名称 🧪' }),
    }),
  );
});

it('does not overwrite a later native name notification with a delayed post-write read', async () => {
  const { service, codex, id } = await setup();
  const gate = deferred<ThreadView>();
  const entered = deferred<void>();
  vi.spyOn(codex, 'readThreadMetadata').mockImplementationOnce(() => {
    entered.resolve();
    return gate.promise;
  });
  const request = input('first');
  const pending = service.renameThread(id, request);
  await entered.promise;
  codex.threads.get(id)!.title = 'newer';
  codex.emit({ type: 'threadName', threadId: id, name: 'newer' });
  gate.resolve({ ...codex.threads.get(id)!, title: 'first' });
  await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(service.getOperation(request.clientOperationId).status).toBe('unknown');
  expect(service.projection.get(id)?.title).toBe('newer');
});

it('keeps a successful native receipt unknown when the stored name does not match the request', async () => {
  const { service, codex, id } = await setup();
  const oldName = codex.threads.get(id)!.title;
  const rename = vi.spyOn(codex, 'renameThread').mockResolvedValueOnce();
  const request = input('requested name');
  await expect(service.renameThread(id, request)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(service.projection.get(id)?.title).toBe(oldName);
  expect(service.getOperation(request.clientOperationId)).toMatchObject({ status: 'unknown' });
  expect((await service.renameThread(id, request)).status).toBe('unknown');
  expect(rename).toHaveBeenCalledTimes(1);
});

it('blocks overlapping rename/archive and project removal until a rename is confirmed', async () => {
  const { service, codex, id } = await setup();
  const gate = deferred<void>();
  vi.spyOn(codex, 'renameThread').mockReturnValueOnce(gate.promise);
  const request = input();
  const pending = service.renameThread(id, request);
  await vi.waitFor(() =>
    expect(service.getOperation(request.clientOperationId).status).toBe('dispatching'),
  );
  await expect(service.renameThread(id, input('second'))).rejects.toMatchObject({
    code: 'THREAD_BUSY',
  });
  await expect(
    service.setThreadArchived(id, { clientOperationId: operationId(), archived: true }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  expect(() => service.removeProject('project')).toThrow('项目仍有活动任务');
  codex.threads.get(id)!.title = request.name;
  gate.resolve();
  await pending;
});

it('retains unknown rename receipts and never replays them, while definite failures allow retry', async () => {
  const { service, codex, id } = await setup();
  const rename = vi.spyOn(codex, 'renameThread');
  rename.mockRejectedValueOnce(new AppError('RENAME_FAILED', '写入被拒绝', 409));
  const rejected = input();
  await expect(service.renameThread(id, rejected)).rejects.toMatchObject({ code: 'RENAME_FAILED' });
  expect(service.getOperation(rejected.clientOperationId).status).toBe('failed');
  await service.renameThread(id, input('retry'));
  rename.mockRejectedValueOnce(new CodexError('RESULT_UNKNOWN', 'timeout', true));
  const uncertain = input();
  await expect(service.renameThread(id, uncertain)).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  expect((await service.renameThread(id, uncertain)).status).toBe('unknown');
  await expect(service.renameThread(id, input('must not retry'))).rejects.toMatchObject({
    code: 'THREAD_BUSY',
  });
  expect(rename).toHaveBeenCalledTimes(3);
});

it('treats failed post-write verification as uncertain, preserving native notifications', async () => {
  const { service, codex, id } = await setup();
  vi.spyOn(codex, 'readThreadMetadata').mockRejectedValueOnce(new Error('read failed'));
  const request = input();
  await expect(service.renameThread(id, request)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(service.projection.get(id)?.title).toBe(request.name);
  expect(service.getOperation(request.clientOperationId).status).toBe('unknown');
});

it('does not acknowledge a rename receipt from an obsolete Codex runtime', async () => {
  const { service, codex, id } = await setup();
  const gate = deferred<void>();
  vi.spyOn(codex, 'renameThread').mockReturnValueOnce(gate.promise);
  const request = input();
  const pending = service.renameThread(id, request);
  await vi.waitFor(() =>
    expect(service.getOperation(request.clientOperationId).status).toBe('dispatching'),
  );
  codex.reset();
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(service.getOperation(request.clientOperationId).status).toBe('unknown');
  expect(service.projection.get(id)?.managed).toBe(false);
});

it('rejects unmanaged and archived histories, compatibility gates and paths outside projects', async () => {
  const { service, codex, id, directory, project } = await setup();
  const rename = vi.spyOn(codex, 'renameThread');
  codex.threads.set('external', threadView('external', project));
  await expect(service.renameThread('external', input())).rejects.toMatchObject({
    code: 'THREAD_NOT_RESUMED',
  });
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  codex.threads.set('outside', threadView('outside', outside));
  await expect(service.renameThread('outside', input())).rejects.toMatchObject({
    code: 'PROJECT_OWNERSHIP',
  });
  codex.compatibility = 'unverified';
  await expect(service.renameThread(id, input())).rejects.toMatchObject({
    code: 'COMPATIBILITY_CONFIRMATION_REQUIRED',
  });
  codex.compatibility = 'verified';
  await service.setThreadArchived(id, { clientOperationId: operationId(), archived: true });
  await expect(service.renameThread(id, input())).rejects.toMatchObject({
    code: 'THREAD_ARCHIVED',
  });
  expect(rename).not.toHaveBeenCalled();
});

it('validates HTTP names, operation IDs, origins and fields before dispatch', async () => {
  const { service, codex, directory, project, id } = await setup();
  const config = parseConfig(
    {
      dataDir: join(directory, 'data'),
      projects: [{ id: 'project', name: 'Test', path: project }],
    },
    join(directory, 'config.json'),
  );
  const app = createApp({ config, service, staticDir: directory });
  const rename = vi.spyOn(codex, 'renameThread');
  const post = (body: unknown, origin = config.publicOrigin[0]) =>
    app.request(`http://127.0.0.1:8787/api/threads/${id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin! },
      body: JSON.stringify(body),
    });
  for (const body of [
    {},
    { name: 'Name' },
    input(''),
    input('  '),
    input('line\nbreak'),
    input('🧪'.repeat(101)),
    { ...input(), cwd: '/tmp' },
  ])
    expect((await post(body)).status).toBe(400);
  expect((await post(input(), 'https://foreign.invalid')).status).toBe(403);
  expect(rename).not.toHaveBeenCalled();
  expect((await post(input('  Valid name  '))).status).toBe(200);
  expect(rename).toHaveBeenCalledExactlyOnceWith(id, 'Valid name');
});

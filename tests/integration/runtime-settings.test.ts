import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeSettings, ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
it('refreshes settings from metadata and never replaces a newer live update with a late read', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const actual = ctx.codex.threads.get(id)!;
  actual.runtimeSettings = { model: 'model-a', reasoningEffort: 'low' };
  expect((await ctx.service.getThread(id)).runtimeSettings).toEqual(actual.runtimeSettings);
  const events: ServerMessage[] = [];
  await ctx.service.subscribe(id, undefined, (event) => events.push(event));
  const late = deferred<ThreadView>();
  vi.spyOn(ctx.codex, 'readThreadMetadata').mockReturnValueOnce(late.promise);
  const reading = ctx.service.getThread(id);
  await Promise.resolve();
  const settings = { model: 'model-b', reasoningEffort: 'high' };
  ctx.codex.emit({ type: 'threadSettings', threadId: id, settings });
  late.resolve(structuredClone(actual));
  expect((await reading).runtimeSettings).toEqual(settings);
  expect(events.at(-1)).toMatchObject({
    kind: 'threadPatch',
    payload: { thread: { runtimeSettings: settings } },
  });
  ctx.service.projection.thread(actual, true);
  expect(ctx.service.projection.get(id)?.runtimeSettings).toEqual(settings);
});

it('keeps loaded permission settings through metadata reads and drops them on runtime reset', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const settings = {
    model: 'model-a',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    sandbox: 'workspace-write' as const,
    approvalPolicy: 'granular' as const,
    approvalReviewer: 'auto_review',
    networkAccess: true,
  };
  ctx.codex.emit({ type: 'threadSettings', threadId: id, settings });
  ctx.codex.threads.get(id)!.runtimeSettings = { model: 'model-a', reasoningEffort: 'high' };
  expect((await ctx.service.getThread(id)).runtimeSettings).toEqual(settings);
  ctx.service.projection.thread(ctx.codex.threads.get(id)!);
  expect(ctx.service.projection.get(id)?.runtimeSettings).toEqual(settings);
  ctx.service.projection.runtimeReset();
  expect(ctx.service.projection.get(id)?.runtimeSettings).toEqual({
    model: 'model-a',
    reasoningEffort: 'high',
  });
});

const confirmedSettings: RuntimeSettings = {
  model: 'model-a',
  reasoningEffort: 'ultra',
  serviceTier: 'fast',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  approvalReviewer: 'auto_review',
  networkAccess: false,
};

it.each(['create', 'resume', 'fork'] as const)(
  '%s retains the confirmed configuration when unrelated notifications arrive before the receipt',
  async (operation) => {
    const ctx = harness();
    resources.push(ctx);
    const source = threadView('saved-thread', ctx.project);
    source.runtimeSettings = { model: 'saved-model', reasoningEffort: 'high' };
    ctx.codex.threads.set(source.id, source);
    await ctx.service.getThread(source.id);
    const id = operation === 'resume' ? source.id : `${operation}-thread`;
    const incoming = { ...structuredClone(source), id };
    const receipt = { ...incoming, runtimeSettings: confirmedSettings };
    const respond = async () => {
      // Another browser can read history before a create/fork response is received.
      ctx.codex.threads.set(id, incoming);
      await ctx.service.getThread(id);
      ctx.codex.emit({ type: 'threadStatus', threadId: id, status: 'running' });
      ctx.codex.emit({ type: 'threadName', threadId: id, name: 'Live title' });
      return structuredClone(receipt);
    };
    vi.spyOn(ctx.codex, `${operation}Thread`).mockImplementation(respond);
    if (operation === 'create')
      await ctx.service.createThread('project', { clientOperationId: operationId() });
    else if (operation === 'resume')
      await ctx.service.resumeThread(source.id, { clientOperationId: operationId() });
    else await ctx.service.forkThread(source.id, { clientOperationId: operationId() });
    expect(ctx.service.projection.get(id)).toMatchObject({
      managed: true,
      status: 'running',
      title: 'Live title',
      runtimeSettings: confirmedSettings,
    });
  },
);

it('treats a repeated settings notification as newer than a pending resume receipt', async () => {
  const ctx = harness();
  resources.push(ctx);
  const source = threadView('saved-thread', ctx.project);
  source.runtimeSettings = confirmedSettings;
  ctx.codex.threads.set(source.id, source);
  await ctx.service.getThread(source.id);
  vi.spyOn(ctx.codex, 'resumeThread').mockImplementation(async () => {
    ctx.codex.emit({
      type: 'threadSettings',
      threadId: source.id,
      settings: structuredClone(confirmedSettings),
    });
    return {
      ...source,
      runtimeSettings: {
        ...confirmedSettings,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
    };
  });
  await ctx.service.resumeThread(source.id, { clientOperationId: operationId() });
  expect(ctx.service.projection.get(source.id)?.runtimeSettings).toEqual(confirmedSettings);
});

it('does not mark a delayed create receipt managed after its runtime has reset', async () => {
  const ctx = harness();
  resources.push(ctx);
  vi.spyOn(ctx.codex, 'createThread').mockImplementation(async () => {
    ctx.codex.reset();
    return {
      ...threadView('old-runtime-thread', ctx.project),
      runtimeSettings: confirmedSettings,
    };
  });
  await expect(
    ctx.service.createThread('project', { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(ctx.service.projection.get('old-runtime-thread')).toBeUndefined();
});

it.each(['create', 'resume', 'fork'] as const)(
  '%s does not replace a newer configuration notification, including explicit null values',
  async (operation) => {
    const ctx = harness();
    resources.push(ctx);
    const source = threadView('saved-thread', ctx.project);
    source.runtimeSettings = confirmedSettings;
    ctx.codex.threads.set(source.id, source);
    await ctx.service.getThread(source.id);
    const id = operation === 'resume' ? source.id : `${operation}-thread`;
    const incoming = { ...structuredClone(source), id };
    const latest: RuntimeSettings = {
      model: null,
      reasoningEffort: null,
      sandbox: null,
      approvalPolicy: null,
      approvalReviewer: null,
      networkAccess: null,
    };
    vi.spyOn(ctx.codex, `${operation}Thread`).mockImplementation(async () => {
      ctx.codex.threads.set(id, incoming);
      await ctx.service.getThread(id);
      ctx.codex.emit({ type: 'threadSettings', threadId: id, settings: latest });
      return structuredClone(incoming);
    });
    if (operation === 'create')
      await ctx.service.createThread('project', { clientOperationId: operationId() });
    else if (operation === 'resume')
      await ctx.service.resumeThread(source.id, { clientOperationId: operationId() });
    else await ctx.service.forkThread(source.id, { clientOperationId: operationId() });
    expect(ctx.service.projection.get(id)?.runtimeSettings).toEqual(latest);
  },
);

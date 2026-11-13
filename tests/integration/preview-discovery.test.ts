import { realpathSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { PreviewDiscovery } from '../../src/server/preview/discovery.js';
import type { ProcessInspector, ProcessSnapshot } from '../../src/server/preview/processes.js';
import type { CodexClient, CodexEvent } from '../../src/codex/types.js';
import { captureLogger } from '../fixtures/logging.js';

const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach((fn) => fn());
});
function harness() {
  const logging = captureLogger();
  const events = new Set<(e: CodexEvent) => void>();
  const codex = {
    epoch: 'epoch-a',
    ready: true,
    pid: 100,
    onEvent: (fn: (e: CodexEvent) => void) => {
      events.add(fn);
      return () => {
        events.delete(fn);
      };
    },
  } as CodexClient;
  let snapshot: ProcessSnapshot = { processes: new Map(), listeners: [] };
  const inspector: ProcessInspector = {
    snapshot: async () => snapshot,
    connected: async () => true,
  };
  const discovery = new PreviewDiscovery(
    codex,
    (thread, cwd) =>
      thread === 'a' && cwd === realpathSync('.')
        ? { projectId: 'project-a', projectName: 'A', canonicalCwd: cwd }
        : undefined,
    inspector,
    logging.logger,
  );
  close.push(() => discovery.close());
  const emit = (event: CodexEvent) => events.forEach((fn) => fn(event));
  return {
    discovery,
    records: logging.records,
    codex,
    emit,
    inspector,
    set: (value: ProcessSnapshot) => {
      snapshot = value;
    },
  };
}
const process = (birth = 'born-a', thread = 'a', call = 'execution-a') => ({
  pid: 201,
  parent: 100,
  birth,
  cwd: realpathSync('.'),
  thread,
  call,
});
const state = (p = process()) => ({
  processes: new Map([[201, p]]),
  listeners: [{ pid: 201, port: 5173, host: '127.0.0.1' as const }],
});
const execution: CodexEvent = {
  type: 'previewExecution',
  threadId: 'a',
  itemId: 'execution-a',
  cwd: realpathSync('.'),
  command: 'vite',
  source: 'agent',
};

it('requires live execution, exact thread/call provenance and project cwd, independently of the shared app-server', async () => {
  const h = harness();
  h.set(state());
  expect((await h.discovery.snapshot('a')).services).toEqual([]);
  h.emit(execution);
  await h.discovery.refresh();
  const services = (await h.discovery.snapshot('a')).services;
  expect(services).toHaveLength(1);
  expect((await h.discovery.snapshot('b')).services).toEqual([]);
  h.set(state(process('born-a', 'b')));
  expect((await h.discovery.snapshot('a')).services[0]!.status).toBe('withdrawn');
  await expect(h.discovery.verify(services[0]!.id)).rejects.toMatchObject({ status: 410 });
});

it('withdraws on PID/port reuse, failed inspection and restart; old IDs never regain access', async () => {
  const h = harness();
  h.set(state());
  h.emit(execution);
  await h.discovery.refresh();
  const first = (await h.discovery.snapshot('a')).services[0]!.id;
  const withdrawn: string[] = [];
  h.discovery.onWithdraw((id) => withdrawn.push(id));
  h.set(state(process('born-b')));
  const rows = (await h.discovery.snapshot('a')).services;
  expect(rows.find((r) => r.id === first)!.status).toBe('withdrawn');
  expect(rows.some((r) => r.status === 'running' && r.id !== first)).toBe(true);
  expect(withdrawn).toContain(first);
  h.inspector.snapshot = async () => {
    throw new Error('permission denied');
  };
  expect((await h.discovery.snapshot('a')).services.every((r) => r.status === 'withdrawn')).toBe(
    true,
  );
  expect(h.records.some((r) => r.event === 'preview.inspection_failed')).toBe(true);
  expect(JSON.stringify(h.records)).not.toContain('permission denied');
  expect(JSON.stringify(h.records)).not.toContain(realpathSync('.'));
  h.inspector.snapshot = async () => state();
  h.emit({ type: 'runtime', diagnostics: { ready: false, codexEpoch: 'epoch-b' } as never });
  expect((await h.discovery.snapshot('a')).services.every((r) => r.status === 'withdrawn')).toBe(
    true,
  );
});

it('does not register standalone project Shell, log URLs or mismatched command identities', async () => {
  const h = harness();
  h.set(state(process('born-a', 'a', 'standalone-shell-id')));
  h.emit(execution);
  expect((await h.discovery.snapshot('a')).services).toEqual([]);
  h.set(state({ ...process(), cwd: '/unrelated' }));
  expect((await h.discovery.snapshot('a')).services).toEqual([]);
});

/** Native OS verification with fixture execution identities; never starts Codex. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { systemInspector } from '../src/server/preview/processes.js';
import { PreviewDiscovery } from '../src/server/preview/discovery.js';
import type { CodexClient, CodexEvent } from '../src/codex/types.js';

const inspector = systemInspector();
assert.ok(inspector, 'An ownership inspector must be available on this verification host');
const root = realpathSync(await mkdtemp(join(tmpdir(), 'covro-preview-native-')));
const children: ChildProcess[] = [];
const source = `const http=require('node:http');const server=http.createServer((q,r)=>r.end('isolated fixture'));server.listen(Number(process.env.FIXTURE_PORT||0),'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));`;
const events = new Set<(event: CodexEvent) => void>();
const codex = {
  epoch: 'fixture-native-a',
  ready: true,
  pid: process.pid,
  onEvent: (fn: (event: CodexEvent) => void) => {
    events.add(fn);
    return () => {
      events.delete(fn);
    };
  },
} as CodexClient;
const cwdA = join(root, 'a-中文');
const cwdB = join(root, 'b');
await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
const discovery = new PreviewDiscovery(
  codex,
  (thread, cwd) =>
    (thread === 'a' && cwd === cwdA) || (thread === 'b' && cwd === cwdB)
      ? { projectId: thread, projectName: thread, canonicalCwd: cwd }
      : undefined,
  inspector,
);
async function child(cwd: string, thread?: string, call?: string, port = 0, argv = '') {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_PORT: String(port),
    FIXTURE_UNRELATED: 'CODEX_THREAD_ID=a CODEX_TOOL_CALL_ID=command-a',
  };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_TOOL_CALL_ID;
  if (thread) env.CODEX_THREAD_ID = thread;
  if (call) env.CODEX_TOOL_CALL_ID = call;
  const child = spawn(process.execPath, ['-e', source, argv], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const [data] = await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('Fixture exited before listening');
    }),
  ]);
  return { child, ...(JSON.parse(String(data)) as { port: number; pid: number }) };
}
const emit = (event: CodexEvent) => events.forEach((fn) => fn(event));
try {
  const a = await child(cwdA, 'a', 'command-a');
  await child(cwdB, 'b', 'command-b');
  const unmarked = await child(
    cwdA,
    undefined,
    undefined,
    0,
    'CODEX_THREAD_ID=a CODEX_TOOL_CALL_ID=command-a',
  );
  assert.equal(
    (await discovery.snapshot('a')).services.length,
    0,
    'Ancestry alone must not establish session ownership',
  );
  emit({
    type: 'previewExecution',
    threadId: 'a',
    itemId: 'command-a',
    cwd: cwdA,
    command: 'fixture HTTP server',
    source: 'agent',
  });
  const service = (await discovery.snapshot('a')).services.find((s) => s.status === 'running')!;
  assert.equal(service.port, a.port);
  assert.equal((await discovery.snapshot('b')).services.length, 0);
  const kernel = await inspector.snapshot(process.pid);
  assert.equal(
    kernel.processes.has(unmarked.pid),
    false,
    'Command arguments must never impersonate environment markers',
  );
  const own = kernel.processes.get(a.pid)!;
  assert.equal(own.cwd, cwdA);
  assert.equal(own.thread, 'a');
  assert.equal(own.call, 'command-a');
  if (process.platform === 'darwin') assert.match(own.birth, /^\d+\.\d{6}$/);
  const socket = connect(a.port, '127.0.0.1');
  await once(socket, 'connect');
  assert.equal(
    await inspector.connected(a.pid, a.port, socket.localPort!),
    true,
    'Verify the accepted connection before HTTP bytes',
  );
  socket.destroy();
  emit({
    type: 'previewExecution',
    threadId: 'b',
    itemId: 'command-b',
    cwd: cwdB,
    command: 'second fixture HTTP server',
    source: 'agent',
  });
  assert.equal(
    (await discovery.snapshot('b')).services.filter((s) => s.status === 'running').length,
    1,
  );
  a.child.kill();
  await once(a.child, 'exit');
  await child(cwdA, 'unrelated', 'unregistered', a.port);
  await assert.rejects(discovery.verify(service.id), { code: 'PREVIEW_WITHDRAWN' });
  assert.equal(
    (await discovery.snapshot('a')).services.filter((s) => s.status === 'running').length,
    0,
    'Port reuse must not restore a previous run',
  );
  emit({ type: 'runtime', diagnostics: { ready: false, codexEpoch: 'fixture-native-b' } as never });
  assert.equal(
    (await discovery.snapshot('b')).services.filter((s) => s.status === 'running').length,
    0,
    'Restart must discard provenance',
  );
  console.log(
    JSON.stringify(
      {
        kind: 'real-os-fixture-execution-events',
        platform: process.platform,
        ancestryAndIdentity: 'passed',
        argvImpersonation: 'rejected',
        connectedOwner: 'passed',
        otherSession: 'excluded',
        processExitAndActualPortReuse: 'passed',
        restartProvenance: 'withdrawn',
        forcedKernelPidReuse: 'not performed; synthetic birth-change test covers this branch',
      },
      null,
      2,
    ),
  );
} finally {
  discovery.close();
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }),
  );
  await rm(root, { recursive: true, force: true });
}

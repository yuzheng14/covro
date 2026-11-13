/** Native OS verification with fixture execution identities; never starts Codex. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { systemInspector } from '../src/server/preview/processes.js';
import { WindowsInspector } from '../src/server/preview/windows.js';
import { PreviewDiscovery } from '../src/server/preview/discovery.js';
import type { CodexClient, CodexEvent } from '../src/codex/types.js';

const inspector = systemInspector();
assert.ok(inspector, 'An ownership inspector must be available on this verification host');
const canonical = process.platform === 'win32' ? realpathSync.native : realpathSync;
const root = canonical(await mkdtemp(join(tmpdir(), 'covro-preview-native-')));
const children: ChildProcess[] = [];
const source = `const http=require('node:http');const server=http.createServer((q,r)=>r.end('isolated fixture'));server.listen(Number(process.env.FIXTURE_PORT||0),process.env.FIXTURE_HOST,()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));`;
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
async function child(
  cwd: string,
  thread?: string,
  call?: string,
  port = 0,
  argv = '',
  host = '127.0.0.1',
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_PORT: String(port),
    FIXTURE_HOST: host,
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
  if (inspector instanceof WindowsInspector) {
    const proof = await inspector.snapshot(process.pid);
    assert.ok(
      proof.processes.has(a.pid),
      JSON.stringify({ kind: 'windows-kernel-proof', diagnostics: inspector.diagnostics }),
    );
    const identity = proof.processes.get(a.pid)!;
    assert.ok(
      identity.cwd === cwdA,
      JSON.stringify({
        kind: 'windows-cwd-proof',
        sameCaseInsensitive: identity.cwd.toLowerCase() === cwdA.toLowerCase(),
        expectedShortName: /~\d/.test(cwdA),
        actualShortName: /~\d/.test(identity.cwd),
        unicodeLeaf: identity.cwd.endsWith('a-中文'),
        sameRealpath: realpathSync(identity.cwd) === cwdA,
        trailingSeparator: identity.cwd.endsWith('\\'),
      }),
    );
    assert.ok(
      identity.thread === 'a' && identity.call === 'command-a',
      'Windows exact markers must match',
    );
    assert.ok(
      proof.listeners.some((listener) => listener.pid === a.pid && listener.port === a.port),
      JSON.stringify({ kind: 'windows-listener-proof', listeners: proof.listeners.length }),
    );
  }
  const service = (await discovery.snapshot('a')).services.find((s) => s.status === 'running')!;
  assert.equal(service.port, a.port);
  assert.equal((await discovery.snapshot('b')).services.length, 0);
  const inspectionStarted = performance.now();
  const kernel = await inspector.snapshot(process.pid);
  const snapshotDurationMs = Math.round(performance.now() - inspectionStarted);
  assert.equal(
    kernel.processes.has(unmarked.pid),
    false,
    'Command arguments must never impersonate environment markers',
  );
  const own = kernel.processes.get(a.pid)!;
  assert.equal(own.cwd, cwdA);
  assert.equal(own.thread, 'a');
  assert.equal(own.call, 'command-a');
  if (process.platform === 'win32') {
    const alias = join(root, 'project-junction');
    await symlink(cwdA, alias, 'junction');
    const linked = await child(alias, 'a', 'junction-proof');
    assert.equal(
      (await inspector.snapshot(process.pid)).processes.get(linked.pid)?.cwd,
      cwdA,
      'Resolve the actual directory handle through a junction, not the logical cwd string',
    );
    linked.child.kill();
    await once(linked.child, 'exit');
  }
  if (process.platform === 'darwin') assert.match(own.birth, /^\d+\.\d{6}$/);
  if (process.platform === 'win32') assert.match(own.birth, /^[1-9]\d{17}$/);
  const socket = connect(a.port, '127.0.0.1');
  await once(socket, 'connect');
  assert.equal(
    await inspector.connected(a.pid, a.port, socket.localPort!, '127.0.0.1'),
    true,
    'Verify the accepted connection before HTTP bytes',
  );
  assert.equal(await inspector.connected(a.pid, a.port, socket.localPort!, '::1'), false);
  socket.destroy();
  const ipv6 = await child(cwdB, 'b', 'ipv6-probe', 0, '', '::1');
  const ipv6Socket = connect(ipv6.port, '::1');
  await once(ipv6Socket, 'connect');
  assert.equal(await inspector.connected(ipv6.pid, ipv6.port, ipv6Socket.localPort!, '::1'), true);
  assert.equal(
    await inspector.connected(ipv6.pid, ipv6.port, ipv6Socket.localPort!, '127.0.0.1'),
    false,
  );
  ipv6Socket.destroy();
  ipv6.child.kill();
  await once(ipv6.child, 'exit');
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
        snapshotDurationMs,
        ancestryAndIdentity: 'passed',
        argvImpersonation: 'rejected',
        connectedOwner: 'passed',
        ipv6AndAddressFamily: 'passed',
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

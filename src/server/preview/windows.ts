import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Listener, ProcessInspector, ProcessSnapshot } from './processes.js';

const pid = z.number().int().positive().max(0x7fffffff);
const port = z.number().int().min(1).max(65535);
const host = z.enum(['127.0.0.1', '::1']);
const birth = z.string().regex(/^[1-9]\d{0,18}$/);
const marker = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const stage = z.enum([
  'startup',
  'tcp',
  'snapshot',
  'ancestry',
  'process_open',
  'process_arch',
  'process_parameters',
  'parameters_read',
  'parameters_length',
  'parameters_flags',
  'parameters_cwd',
  'remote_pointer',
  'remote_read',
  'remote_count',
  'environment',
  'cwd_duplicate',
  'cwd_attributes',
  'cwd_path',
  'process_stability',
]);
const identity = z
  .object({
    pid,
    parent: pid,
    birth,
    cwd: z
      .string()
      .max(32768)
      .regex(/^[a-zA-Z]:\\/),
    thread: marker,
    call: marker,
  })
  .strict();
const snapshot = z
  .object({
    root: pid,
    rootBirth: birth,
    diagnostics: z.partialRecord(stage, z.number().int().min(0).max(4096)).optional(),
    processes: z.array(identity).max(256),
    listeners: z.array(z.object({ pid, port, host }).strict()).max(4096),
  })
  .strict();
const response = z.discriminatedUnion('ok', [
  z.object({ id: pid, ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      id: pid,
      ok: z.literal(false),
      error: z.literal('query_failed'),
      stage: stage.optional(),
    })
    .strict(),
]);
const probe = fileURLToPath(new URL('../../../bin/process-windows.ps1', import.meta.url));
function systemWorker() {
  // Fixed system path and our package's source only. No shell interpolation,
  // execution-policy override, compiler, saved assembly or downloaded runtime.
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return spawn(
    executable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '& { & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:COVRO_PREVIEW_PROBE))) }',
    ],
    { windowsHide: true, env: { ...process.env, COVRO_PREVIEW_PROBE: probe }, stdio: 'pipe' },
  );
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type Worker = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  accept(): void;
  reject(error: Error): void;
  startup: NodeJS.Timeout;
  started: boolean;
  buffer: string;
  pending: Map<number, Pending>;
};
const unavailable = () => new Error('Windows preview process inspection is unavailable');

/** Persistent, bounded protocol with a source-only system PowerShell worker.
 * Only exact execution markers, canonical cwd and kernel identities leave it.
 * Any failed query withdraws ownership; helper recovery never restores old runs. */
export class WindowsInspector implements ProcessInspector {
  /** Fixed count metadata only, for verification and fail-closed diagnostics. */
  diagnostics: Partial<Record<z.infer<typeof stage>, number>> = {};
  private worker?: Worker;
  private closed = false;
  private sequence = 0;
  private rootIdentity?: { pid: number; birth: string };
  constructor(
    private readonly startWorker: () => ChildProcessWithoutNullStreams = systemWorker,
    private readonly timeoutMs = 10000,
  ) {}
  private stop(worker: Worker) {
    if (this.worker === worker) this.worker = undefined;
    clearTimeout(worker.startup);
    worker.reject(unavailable());
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(unavailable());
    }
    worker.pending.clear();
    worker.child.kill();
    worker.child.stdin.destroy();
    worker.child.stdout.destroy();
    worker.child.stderr.destroy();
  }
  private start() {
    if (this.closed) throw unavailable();
    if (this.worker) return this.worker;
    const child = this.startWorker();
    let accept!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    const worker: Worker = {
      child,
      ready,
      accept,
      reject,
      startup: setTimeout(() => this.stop(worker), this.timeoutMs),
      started: false,
      buffer: '',
      pending: new Map(),
    };
    this.worker = worker;
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      if (stream instanceof Socket) stream.unref();
    child.on('error', () => this.stop(worker));
    child.on('exit', () => this.stop(worker));
    child.stdin.on('error', () => this.stop(worker));
    child.stdout.on('error', () => this.stop(worker));
    child.stderr.on('error', () => this.stop(worker));
    // stderr can contain native/PowerShell exceptions. Never retain or forward it.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.worker !== worker) return;
      worker.buffer += chunk;
      if (worker.buffer.length > 8 * 1024 * 1024) return this.stop(worker);
      let end: number;
      while ((end = worker.buffer.indexOf('\n')) >= 0) {
        const line = worker.buffer.slice(0, end).replace(/\r$/, '');
        worker.buffer = worker.buffer.slice(end + 1);
        try {
          const data: unknown = JSON.parse(line);
          if (!worker.started) {
            z.object({ ready: z.literal(true) })
              .strict()
              .parse(data);
            worker.started = true;
            clearTimeout(worker.startup);
            worker.accept();
          } else {
            const frame = response.parse(data);
            const pending = worker.pending.get(frame.id);
            if (!pending) return this.stop(worker);
            clearTimeout(pending.timer);
            worker.pending.delete(frame.id);
            if (frame.ok) pending.resolve(frame.result);
            else {
              if (frame.stage) this.diagnostics = { [frame.stage]: 1 };
              pending.reject(unavailable());
            }
          }
        } catch {
          return this.stop(worker);
        }
      }
    });
    return worker;
  }
  private async query(request: Record<string, string | number>) {
    const worker = this.start();
    await worker.ready;
    if (this.worker !== worker || this.closed || worker.pending.size >= 128) throw unavailable();
    const id = (this.sequence = (this.sequence % 0x7fffffff) + 1);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(worker), this.timeoutMs);
      worker.pending.set(id, { resolve, reject, timer });
      worker.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
        if (error) this.stop(worker);
      });
    });
  }
  async snapshot(root: number): Promise<ProcessSnapshot> {
    pid.parse(root);
    const data = snapshot.safeParse(await this.query({ method: 'snapshot', root }));
    if (!data.success || data.data.root !== root) throw unavailable();
    this.diagnostics = data.data.diagnostics ?? {};
    if (this.rootIdentity?.pid === root && this.rootIdentity.birth !== data.data.rootBirth)
      throw unavailable();
    this.rootIdentity = { pid: root, birth: data.data.rootBirth };
    const processes = new Map(data.data.processes.map((entry) => [entry.pid, entry]));
    if (
      processes.size !== data.data.processes.length ||
      processes.has(root) ||
      data.data.listeners.some((entry) => !processes.has(entry.pid))
    )
      throw unavailable();
    return { processes, listeners: data.data.listeners };
  }
  async connected(
    targetId: number,
    serverPort: number,
    clientPort: number,
    address: Listener['host'],
  ) {
    pid.parse(targetId);
    port.parse(serverPort);
    port.parse(clientPort);
    host.parse(address);
    const data = z
      .object({ connected: z.boolean() })
      .strict()
      .safeParse(
        await this.query({
          method: 'connected',
          pid: targetId,
          port: serverPort,
          clientPort,
          host: address,
        }),
      );
    if (!data.success) throw unavailable();
    return data.data.connected;
  }
  close() {
    this.closed = true;
    if (this.worker) this.stop(this.worker);
  }
}

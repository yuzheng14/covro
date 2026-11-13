import { randomUUID } from 'node:crypto';
import type { CodexClient, CodexEvent } from '../../codex/types.js';
import { AppError } from '../../shared/errors.js';
import type { PreviewService } from '../../shared/dev-preview.js';
import { systemInspector, type ProcessIdentity, type ProcessInspector } from './processes.js';
import { containsPath } from '../projects.js';
import { nullLogger, type Logger } from '../../logging/logger.js';
import { errorFields } from '../../logging/fields.js';

export interface RegisteredService extends PreviewService {
  host: '127.0.0.1' | '::1';
  process: ProcessIdentity;
  epoch: string;
}
interface Execution {
  threadId: string;
  itemId: string;
  cwd: string;
  command: string;
}
/** Only live execution events establish candidates. Never restore ports from disk/history. */
export class PreviewDiscovery {
  private readonly executions = new Map<string, Execution>();
  private readonly runs = new Map<string, RegisteredService>();
  private readonly listeners = new Set<(id: string) => void>();
  private epoch: string;
  private error?: string;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private closed = false;
  private readonly removeListener: () => void;
  constructor(
    private readonly codex: CodexClient,
    private readonly context: (
      thread: string,
      cwd: string,
    ) => { projectId: string | null; projectName: string; canonicalCwd: string } | undefined,
    readonly inspector: ProcessInspector | undefined = systemInspector(),
    private readonly logger: Logger = nullLogger,
  ) {
    this.epoch = codex.epoch;
    this.removeListener = codex.onEvent((event) => this.observe(event));
    if (inspector) {
      this.timer = setInterval(() => void this.refresh(), 1000);
      this.timer.unref();
    }
  }
  private observe(event: CodexEvent) {
    if (this.closed) return;
    if (
      event.type === 'runtime' &&
      (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.epoch)
    ) {
      this.executions.clear();
      this.epoch = event.diagnostics.codexEpoch;
      for (const run of this.runs.values()) this.withdraw(run);
    }
    if (event.type !== 'previewExecution') return;
    // Interaction events refer to a different tool call; they cannot rebind a process.
    if (!['agent', 'unifiedExecStartup', 'userShell'].includes(event.source)) return;
    if (!this.context(event.threadId, event.cwd)) return;
    this.executions.set(`${event.threadId}\0${event.itemId}`, event);
    // Bound retained provenance; never evict an active service's record.
    if (this.executions.size > 2048) {
      const used = new Set(
        [...this.runs.values()]
          .filter((r) => r.status === 'running')
          .map((r) => `${r.threadId}\0${r.process.call}`),
      );
      for (const key of this.executions.keys()) {
        if (!used.has(key)) this.executions.delete(key);
        if (this.executions.size <= 1024) break;
      }
    }
    void this.refresh();
  }
  onWithdraw(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private withdraw(run: RegisteredService) {
    if (run.status === 'withdrawn') return;
    run.status = 'withdrawn';
    run.reason = 'Process ownership or listener is no longer valid';
    this.logger.info('preview.service_withdrawn', {
      threadId: run.threadId,
      codexEpoch: run.epoch,
      reason: 'ownership_invalid',
    });
    for (const listener of this.listeners) listener(run.id);
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.scanning ??= this.scan().finally(() => {
      this.scanning = undefined;
    }));
  }
  private async scan() {
    if (this.closed || !this.inspector || !this.codex.ready || !this.codex.pid) {
      for (const run of this.runs.values()) this.withdraw(run);
      return;
    }
    const epoch = this.epoch;
    try {
      const snapshot = await this.inspector.snapshot(this.codex.pid);
      if (this.closed || epoch !== this.epoch || !this.codex.ready) return;
      const current = new Set<string>();
      for (const listener of snapshot.listeners) {
        const process = snapshot.processes.get(listener.pid);
        if (!process?.thread || !process.call) continue;
        const execution = this.executions.get(`${process.thread}\0${process.call}`);
        if (!execution) continue;
        const context = this.context(execution.threadId, execution.cwd);
        if (this.closed || epoch !== this.epoch) return;
        if (!context || !containsPath(context.canonicalCwd, process.cwd)) continue;
        const existing = [...this.runs.values()].find(
          (r) =>
            r.status === 'running' &&
            r.epoch === epoch &&
            r.process.pid === process.pid &&
            r.process.birth === process.birth &&
            r.process.call === process.call &&
            r.process.thread === process.thread &&
            r.port === listener.port &&
            r.host === listener.host,
        );
        const run: RegisteredService = existing ?? {
          id: randomUUID(),
          ...context,
          threadId: execution.threadId,
          command: execution.command,
          port: listener.port,
          host: listener.host,
          process,
          epoch,
          status: 'running',
        };
        this.runs.set(run.id, run);
        if (!existing)
          this.logger.info('preview.service_registered', {
            threadId: run.threadId,
            codexEpoch: epoch,
            port: run.port,
          });
        current.add(run.id);
      }
      for (const run of this.runs.values()) if (!current.has(run.id)) this.withdraw(run);
      this.error = undefined;
      while (this.runs.size > 100) {
        const oldest = [...this.runs.values()].find((r) => r.status === 'withdrawn');
        if (!oldest) break;
        this.runs.delete(oldest.id);
      }
    } catch (error) {
      if (!this.error)
        this.logger.warn('preview.inspection_failed', {
          ...errorFields(error),
          codexEpoch: epoch,
          reason: (error as { killed?: boolean })?.killed
            ? 'inspection_timeout'
            : 'inspection_failed',
        });
      this.error = 'Process inspection failed; preview access has been withdrawn';
      for (const run of this.runs.values()) this.withdraw(run);
    }
  }
  async snapshot(threadId: string) {
    await this.refresh();
    return {
      available: Boolean(this.inspector),
      ...(this.error ? { error: this.error } : {}),
      services: [...this.runs.values()]
        .filter((r) => r.threadId === threadId)
        .map((r): PreviewService => ({
          id: r.id,
          threadId: r.threadId,
          projectId: r.projectId,
          projectName: r.projectName,
          command: r.command,
          port: r.port,
          status: r.status,
          ...(r.reason ? { reason: r.reason } : {}),
        })),
    };
  }
  async verify(id: string): Promise<RegisteredService> {
    await this.refresh();
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || run.epoch !== this.epoch)
      throw new AppError(
        'PREVIEW_WITHDRAWN',
        'Development service ownership is no longer valid',
        410,
      );
    return run;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.removeListener();
    for (const run of this.runs.values()) this.withdraw(run);
    this.executions.clear();
    this.inspector?.close?.();
  }
}

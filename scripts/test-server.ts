/** Explicit fixture-backed browser test entry. Production never imports this module. */
import { mkdtemp, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';
import type { CodexClient, CodexDiagnostics, CodexEvent } from '../src/codex/types.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';
import { AppError } from '../src/shared/errors.js';

/** Test-only diagnostics controls; the production adapter has no hook. */
class ControlledFixture implements CodexClient {
  refreshAccountUsage = () => this.inner.refreshAccountUsage!();
  executeCommand: NonNullable<CodexClient['executeCommand']> = (...args) =>
    this.inner.executeCommand!(...args);
  terminateCommand: NonNullable<CodexClient['terminateCommand']> = (...args) =>
    this.inner.terminateCommand!(...args);
  private version = 'fixture-unverified-1';
  private unavailable = false;
  private seedingExternal = false;
  private readonly externalFailures = new Map<string, AppError>();
  private readonly listeners = new Set<(event: CodexEvent) => void>();
  constructor(
    private readonly inner: CodexClient,
    private readonly historyPath: string,
  ) {
    inner.onEvent((event) => {
      // History written by another app-server has no live notifications in this gateway.
      if (this.seedingExternal && event.type !== 'runtime') return;
      this.publish(
        event.type === 'runtime' ? { type: 'runtime', diagnostics: this.diagnostics() } : event,
      );
    });
  }
  get epoch() {
    return this.inner.epoch;
  }
  get pid() {
    return this.inner.pid;
  }
  get ready() {
    return this.inner.ready && !this.unavailable;
  }
  diagnostics(): CodexDiagnostics {
    return {
      ...this.inner.diagnostics(),
      codexVersion: this.version,
      compatibility: 'unverified',
      ready: this.ready,
      ...(this.unavailable
        ? { connection: 'unavailable' as const, error: '测试进程已不可用' }
        : {}),
    };
  }
  onEvent(listener: (event: CodexEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start() {
    return this.inner.start();
  }
  stop() {
    return this.inner.stop();
  }
  archiveThread: CodexClient['archiveThread'] = (...args) => this.inner.archiveThread(...args);
  renameThread: CodexClient['renameThread'] = (...args) => this.inner.renameThread(...args);
  unarchiveThread: CodexClient['unarchiveThread'] = (...args) =>
    this.inner.unarchiveThread(...args);
  listThreads: CodexClient['listThreads'] = (...args) => this.inner.listThreads(...args);
  listSkills: NonNullable<CodexClient['listSkills']> = (...args) => this.inner.listSkills!(...args);
  readRuntimeSettings: CodexClient['readRuntimeSettings'] = (...args) =>
    this.inner.readRuntimeSettings(...args);
  saveModelDefaults: CodexClient['saveModelDefaults'] = (...args) =>
    this.inner.saveModelDefaults(...args);
  readThreadPage: CodexClient['readThreadPage'] = (...args) => this.inner.readThreadPage!(...args);
  readThread: CodexClient['readThread'] = (...args) => this.inner.readThread(...args);
  readThreadMetadata: CodexClient['readThreadMetadata'] = (...args) =>
    this.inner.readThreadMetadata(...args);
  createThread: CodexClient['createThread'] = (...args) => this.inner.createThread(...args);
  forkThread: CodexClient['forkThread'] = (...args) => this.inner.forkThread(...args);
  resumeThread: CodexClient['resumeThread'] = async (...args) => {
    const failure = this.externalFailures.get(args[0]);
    if (failure) throw failure;
    return this.inner.resumeThread(...args);
  };
  async seedExternal(cwd: string, state: 'free' | 'occupied' | 'error') {
    // Deliberately bypass the gateway's create/resume methods: this history is unmanaged.
    this.seedingExternal = true;
    try {
      const thread = await this.inner.createThread(cwd);
      if (state !== 'free')
        this.externalFailures.set(
          thread.id,
          state === 'occupied'
            ? new AppError('THREAD_IN_USE', '此会话正被其他进程使用', 409)
            : new AppError('CODEX_REQUEST_FAILED', '测试历史格式无法恢复', 400),
        );
      await this.inner.startTurn(thread.id, cwd, '已保存的会话历史');
      for (let i = 0; i < 100; i++) {
        const history = await this.inner.readThread(thread.id);
        if (history.turns.some((turn) => turn.status === 'completed')) return thread.id;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('External fixture did not finish');
    } finally {
      this.seedingExternal = false;
    }
  }
  releaseExternal(id: string) {
    this.externalFailures.delete(id);
  }
  startTurn: CodexClient['startTurn'] = (...args) => this.inner.startTurn(...args);
  startReview: CodexClient['startReview'] = (...args) => this.inner.startReview(...args);
  steerTurn: CodexClient['steerTurn'] = (...args) => this.inner.steerTurn(...args);
  interruptTurn: CodexClient['interruptTurn'] = (...args) => this.inner.interruptTurn(...args);
  getGoal = (id: string) => this.inner.getGoal!(id);
  mutateGoal: NonNullable<CodexClient['mutateGoal']> = (...args) => this.inner.mutateGoal!(...args);
  recapThread = (id: string, prompt: string) => this.inner.recapThread!(id, prompt);
  listGuardianDenials = (id: string) => this.inner.listGuardianDenials!(id);
  approveGuardianDenial = (id: string, denialId: string) =>
    this.inner.approveGuardianDenial!(id, denialId);
  compactThread: CodexClient['compactThread'] = (...args) => this.inner.compactThread(...args);
  respond: CodexClient['respond'] = (...args) => this.inner.respond(...args);
  async reset(version = 'fixture-unverified-1') {
    await this.stop();
    await rm(this.historyPath, { force: true });
    this.version = version;
    this.unavailable = false;
    this.externalFailures.clear();
  }
  update(version: string | undefined, unavailable: boolean | undefined) {
    if (version !== undefined) this.version = version;
    if (unavailable !== undefined) this.unavailable = unavailable;
    this.publish({ type: 'runtime', diagnostics: this.diagnostics() });
  }
  private publish(event: CodexEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const root = await mkdtemp(join(tmpdir(), 'codex-web-e2e-'));
const project = join(root, 'project');
const otherProject = join(root, 'other-project');
const historyPath = join(root, 'history.json');
const accountUsagePath = join(root, 'account-usage.json');
const port = Number(process.env.E2E_PORT ?? 8788);
const origin = `http://127.0.0.1:${port}`;
await mkdir(project);
await mkdir(otherProject);
const config = parseConfig(
  {
    port,
    publicOrigin: [origin],
    dataDir: join(root, 'data'),
    projects: [
      { id: 'fixture', name: '测试项目', path: project },
      { id: 'fixture-other', name: '另一个项目', path: otherProject },
      { id: 'fixture-unavailable', name: '不可用项目', path: join(root, 'missing-project') },
    ],
  },
  join(root, 'config.json'),
);
config.demo = true;
const codex = new ControlledFixture(
  new CodexAdapter({
    binary: resolve('tests/fixtures/codex.mjs'),
    args: [
      '--options',
      JSON.stringify({
        fragmentBytes: 7,
        turnDelayMs: 800,
        titleDelayMs: 1500,
        historyPath,
        accountUsagePath,
        models: ['simulated-model', 'simulated-alternative'],
      }),
    ],
  }),
  historyPath,
);
let runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });

// Separate loopback control listener exists only in this explicit test entry. Requests from a
// browser Origin are refused. It never adds a route or bypass to the production gateway.
let controlling = Promise.resolve();
const control = createServer((request, response) => {
  void (async () => {
    if (
      request.method !== 'POST' ||
      request.url !== '/runtime' ||
      request.headers.origin ||
      request.headers['content-type'] !== 'application/json'
    ) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) {
        response.writeHead(413).end();
        return;
      }
    }
    const input = JSON.parse(body) as {
      reset?: boolean;
      restart?: boolean;
      version?: string;
      unavailable?: boolean;
      external?: 'free' | 'occupied' | 'error';
      releaseThreadId?: string;
      accountUsage?: object;
    };
    if (
      input.version !== undefined &&
      (typeof input.version !== 'string' || input.version.length > 80)
    ) {
      response.writeHead(400).end();
      return;
    }
    if (input.unavailable !== undefined && typeof input.unavailable !== 'boolean') {
      response.writeHead(400).end();
      return;
    }
    let externalThreadId: string | undefined;
    const work = controlling.then(async () => {
      if (input.reset === true) await rm(accountUsagePath, { force: true });
      if (input.accountUsage) {
        await writeFile(`${accountUsagePath}.tmp`, JSON.stringify(input.accountUsage));
        await rename(`${accountUsagePath}.tmp`, accountUsagePath);
      }
      if (input.restart === true) {
        await runtime.close();
        runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
      } else if (input.reset === true) {
        // A test reset must clear durable gateway intent as well as upstream history.
        // Restart above deliberately preserves that data for recovery tests.
        await runtime.close();
        await rm(join(root, 'data'), { recursive: true, force: true });
        await codex.reset(input.version);
        runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
      } else codex.update(input.version, input.unavailable);
      if (input.releaseThreadId) codex.releaseExternal(input.releaseThreadId);
      if (input.external) externalThreadId = await codex.seedExternal(project, input.external);
    });
    controlling = work.catch(() => {});
    await work;
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ...runtime.service.getSystem(), externalThreadId }));
  })().catch((error: unknown) => {
    response.writeHead(500).end(error instanceof Error ? error.message : 'Fixture control failed');
  });
});
await new Promise<void>((resolveListening, reject) => {
  control.once('error', reject);
  control.listen(port + 1, '127.0.0.1', resolveListening);
});
console.log(`Explicit fixture server: ${origin}`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  control.close();
  control.closeAllConnections();
  void runtime.close().finally(async () => {
    await rm(root, { recursive: true, force: true });
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);

import { CODEX_COMPATIBILITY } from './compatibility.js';
import { SHELL_TIMEOUT_MS, SHELL_OUTPUT_BYTES } from '../shared/shell.js';
import type { CommandExecResponse } from './generated/v2/CommandExecResponse.js';
import type { CommandExecTerminateResponse } from './generated/v2/CommandExecTerminateResponse.js';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { GuardianDenials } from './guardian-denials.js';
import { ThreadTitles } from './thread-titles.js';
import {
  collaborationSelection,
  reportedCollaborationMode,
  type CollaborationProvenance,
} from './collaboration.js';
import { TurnTokenUsage } from './turn-token-usage.js';
import { AppError } from '../shared/errors.js';
import { threadNameError } from '../shared/thread-name.js';
import { permissionModeUnavailable, permissionReviewerUnavailable } from '../shared/permissions.js';
import {
  permissionCapabilities,
  type PermissionRequirements,
  type ProfileProvenance,
} from './permissions.js';
import { mapAutoReview } from './auto-review.js';
import {
  normalizeElicitationRequest,
  validateElicitationResolution,
  validatePermissionResolution,
} from '../shared/elicitation.js';
import type {
  ActionResolution,
  PermissionCapabilities,
  RuntimeSettings,
  ReviewTarget,
  PendingAction,
  Settings,
  ModelDefaults,
  ModelDefaultsResult,
  ThreadPage,
  ThreadView,
  TurnView,
} from '../shared/types.js';
import type { ClientRequest } from './generated/ClientRequest.js';
import type { ServerNotification } from './generated/ServerNotification.js';
import type { ServerRequest } from './generated/ServerRequest.js';
import type { InitializeResponse } from './generated/InitializeResponse.js';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.js';
import type { ModelListResponse } from './generated/v2/ModelListResponse.js';
import type { ConfigReadResponse } from './generated/v2/ConfigReadResponse.js';
import type { ConfigWriteResponse } from './generated/v2/ConfigWriteResponse.js';
import type { ConfigRequirementsReadResponse } from './generated/v2/ConfigRequirementsReadResponse.js';
import type { ExperimentalFeatureListResponse } from './generated/v2/ExperimentalFeatureListResponse.js';
import type { Thread } from './generated/v2/Thread.js';
import type { ThreadArchiveResponse } from './generated/v2/ThreadArchiveResponse.js';
import type { ThreadSetNameResponse } from './generated/v2/ThreadSetNameResponse.js';
import type { ThreadUnarchiveResponse } from './generated/v2/ThreadUnarchiveResponse.js';
import type { ThreadLoadedListResponse } from './generated/v2/ThreadLoadedListResponse.js';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse.js';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse.js';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js';
import type { ThreadForkResponse } from './generated/v2/ThreadForkResponse.js';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse.js';
import type { ThreadItemsListResponse } from './generated/v2/ThreadItemsListResponse.js';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.js';
import type { ReviewStartResponse } from './generated/v2/ReviewStartResponse.js';
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse.js';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse.js';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision.js';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse.js';
import type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse.js';
import type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse.js';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse.js';
import type { FileSystemPath } from './generated/v2/FileSystemPath.js';
import {
  mapItem,
  mapThread,
  mapTurn,
  mapTurnError,
  permissionSettings,
  serviceTierSettings,
  threadSettings,
  threadStatus,
  turnSettings,
  taskInput,
} from './mapping.js';
import {
  asCodexError,
  CodexError,
  isRecord,
  RpcTransport,
  type RpcId,
  type RpcNotification,
  type RpcServerRequest,
} from './transport.js';
import type { CodexClient, CodexDiagnostics, CodexEvent } from './types.js';
import type { ThreadCompactStartResponse } from './generated/v2/ThreadCompactStartResponse.js';
export type {
  CodexClient,
  CodexDiagnostics,
  CodexEvent,
  CodexEvent as AdapterEvent,
} from './types.js';
export { CodexError } from './transport.js';

export const VERIFIED_CODEX_VERSION = CODEX_COMPATIBILITY.recommended;
const CAPABILITIES = [
  'command/exec',
  'command/exec/terminate',
  'thread/name/set',
  'thread/start',
  'thread/fork',
  'thread/read',
  'thread/list',
  'thread/resume',
  'thread/archive',
  'thread/loaded/list',
  'thread/unarchive',
  'thread/compact/start',
  'thread/turns/list',
  'thread/items/list',
  'turn/start',
  'review/start',
  'thread/approveGuardianDeniedAction',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'config/read',
  'config/batchWrite',
  'configRequirements/read',
  'experimentalFeature/list',
  'account/read',
];
type Responses = {
  'command/exec': CommandExecResponse;
  'command/exec/terminate': CommandExecTerminateResponse;
  'thread/name/set': ThreadSetNameResponse;
  initialize: InitializeResponse;
  'account/read': GetAccountResponse;
  'model/list': ModelListResponse;
  'config/read': ConfigReadResponse;
  'config/batchWrite': ConfigWriteResponse;
  'configRequirements/read': ConfigRequirementsReadResponse;
  'experimentalFeature/list': ExperimentalFeatureListResponse;
  'thread/list': ThreadListResponse;
  'thread/read': ThreadReadResponse;
  'thread/start': ThreadStartResponse;
  'thread/fork': ThreadForkResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/loaded/list': ThreadLoadedListResponse;
  'thread/archive': ThreadArchiveResponse;
  'thread/unarchive': ThreadUnarchiveResponse;
  'thread/compact/start': ThreadCompactStartResponse;
  'thread/turns/list': ThreadTurnsListResponse;
  'thread/items/list': ThreadItemsListResponse;
  'turn/start': TurnStartResponse;
  'review/start': ReviewStartResponse;
  'thread/approveGuardianDeniedAction': unknown;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
};
export interface CodexAdapterOptions {
  binary: string;
  home?: string;
  /** Explicit argument override for the test simulator; production leaves this unset. */
  args?: string[];
  requestTimeoutMs?: number;
  titleTimeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}
type ActionContext = {
  action: PendingAction;
  request: ServerRequest;
  decisions: Map<string, CommandExecutionApprovalDecision>;
  responding: boolean;
};

function permissionPathLabel(path: FileSystemPath): string {
  if (path.type === 'path') return path.path;
  if (path.type === 'glob_pattern') return `匹配：${path.pattern}`;
  const special = path.value;
  const subpath =
    'subpath' in special && special.subpath !== null ? `（子路径：${special.subpath}）` : '';
  switch (special.kind) {
    case 'root':
      return '整个文件系统（/）';
    case 'minimal':
      return '系统基础运行目录';
    case 'project_roots':
      return `项目根目录${subpath}`;
    case 'tmpdir':
      return '系统临时目录（TMPDIR）';
    case 'slash_tmp':
      return '/tmp';
    case 'unknown':
      return `特殊路径：${special.path}${subpath}`;
  }
}

export class CodexAdapter implements CodexClient {
  private readonly commandOutputs = new Map<
    string,
    Parameters<NonNullable<CodexClient['executeCommand']>>[3]
  >();
  epoch = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: RpcTransport;
  private stopped = true;
  private starting?: Promise<void>;
  private recovering?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempt = 0;
  private titles?: ThreadTitles;
  private readonly denials = new GuardianDenials();
  private readonly tokenUsage = new TurnTokenUsage();
  // Ordering only. Persisted archive state belongs exclusively to Codex.
  private archiveSequence = 0;
  private readonly archives = new Map<string, { archived: boolean; sequence: number }>();
  private listeners = new Set<(event: CodexEvent) => void>();
  private actions = new Map<string, ActionContext>();
  private actionIds = new Map<RpcId, string>();
  private stderrTail = Buffer.alloc(0);
  private disabled = new Set<string>();
  private permissionState = new Map<string, RuntimeSettings>();
  private state: CodexDiagnostics = {
    ready: false,
    connection: 'starting',
    codexVersion: null,
    verifiedVersion: VERIFIED_CODEX_VERSION,
    compatibility: 'unavailable',
    codexEpoch: this.epoch,
    authenticated: null,
    models: [],
    capabilities: [],
  };
  constructor(private readonly options: CodexAdapterOptions) {}
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get ready(): boolean {
    return this.state.ready;
  }
  diagnostics(): CodexDiagnostics {
    return structuredClone(this.state);
  }
  onEvent(listener: (event: CodexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: CodexEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private publishRuntime(): void {
    this.emit({ type: 'runtime', diagnostics: this.diagnostics() });
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async startProcess(): Promise<void> {
    if (this.child) throw new CodexError('CODEX_BUSY', 'Codex app-server is already started');
    this.epoch = randomUUID();
    this.disabled.clear();
    this.archives.clear();
    this.state = {
      ...this.state,
      codexEpoch: this.epoch,
      ready: false,
      connection: 'starting',
      error: undefined,
      capabilities: [],
    };
    this.publishRuntime();
    try {
      const env = {
        ...process.env,
        ...(this.options.home === undefined ? {} : { CODEX_HOME: this.options.home }),
      };
      const { stdout } = await promisify(execFile)(this.options.binary, ['--version'], {
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const version = stdout.trim().replace(/^codex-cli\s+/, '');
      this.state.codexVersion = version;
      this.permissionState.clear();
      this.denials.clear();
      this.state.compatibility = CODEX_COMPATIBILITY.verified.includes(version)
        ? 'verified'
        : 'unverified';
      const child = spawn(
        this.options.binary,
        this.options.args ?? ['app-server', '--listen', 'stdio://'],
        { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false },
      );
      this.child = child;
      const rpc = new RpcTransport(child.stdin, child.stdout, {
        timeoutMs: this.options.requestTimeoutMs,
        maxLineBytes: this.options.maxLineBytes,
      });
      this.rpc = rpc;
      this.titles = new ThreadTitles(rpc, this.options.titleTimeoutMs);
      child.stderr.on('data', (chunk: Buffer) => {
        const max = this.options.maxStderrBytes ?? 64 * 1024;
        this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-max)]).subarray(-max);
      });
      child.on('error', (error) =>
        rpc.fail(new CodexError('CODEX_UNAVAILABLE', `Cannot start Codex: ${error.message}`, true)),
      );
      child.on('exit', (code, signal) => {
        rpc.fail(
          new CodexError(
            'CODEX_UNAVAILABLE',
            `Codex exited (${signal ?? code ?? 'unknown'})`,
            true,
          ),
        );
        if (this.child === child) this.child = undefined;
      });
      rpc.on('notification', (message: RpcNotification) => {
        try {
          this.notification(message);
        } catch (error) {
          rpc.fail(asCodexError(error));
        }
      });
      rpc.on('request', (message: RpcServerRequest) => {
        void this.serverRequest(message).catch((error: unknown) => rpc.fail(asCodexError(error)));
      });
      rpc.on('failure', (error: CodexError) => {
        if (this.rpc !== rpc) return;
        const wasReady = this.ready;
        this.state.ready = false;
        this.tokenUsage.clear();
        this.denials.clear();
        this.state.connection = 'unavailable';
        this.state.error = error.message;
        this.expireActions();
        this.publishRuntime();
        if (!child.killed) child.kill('SIGTERM');
        const kill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2500);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
        if (wasReady && !this.stopped) {
          // Only metadata is logged: never RPC params, results, or session contents.
          console.error('Codex transport failed', {
            code: error.code,
            ...(error.details as object),
          });
          this.scheduleRestart();
        }
      });
      const initialized = await this.call(
        'initialize',
        {
          clientInfo: { name: 'codex_web_ui', title: 'Codex Web UI', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            explicitGatewayOauth: true,
          },
        },
        true,
      );
      if (!isRecord(initialized) || typeof initialized.userAgent !== 'string')
        throw new CodexError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex initialize returned a malformed result',
          true,
        );
      await rpc.notify('initialized');
      const [account, models] = await Promise.all([
        this.call('account/read', { refreshToken: false }, true),
        this.call('model/list', { limit: 100 }, true),
      ]);
      if (
        !isRecord(account) ||
        !Object.hasOwn(account, 'account') ||
        typeof account.requiresOpenaiAuth !== 'boolean'
      )
        throw new CodexError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex account/read returned a malformed result',
          true,
        );
      this.state.authenticated = account.account !== null || !account.requiresOpenaiAuth;
      this.state.models = models.data.map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        reasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        defaultReasoningEffort: model.defaultReasoningEffort,
        serviceTiers:
          model.serviceTiers?.map((tier) => (tier.id === 'priority' ? 'fast' : tier.id)) ??
          model.additionalSpeedTiers,
      }));
      let cursor = models.nextCursor;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 100)
          throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid model pagination');
        seen.add(cursor);
        const page = await this.call('model/list', { limit: 100, cursor }, true);
        this.state.models.push(
          ...page.data.map((model) => ({
            id: model.model,
            name: model.displayName,
            description: model.description,
            reasoningEfforts: model.supportedReasoningEfforts.map(
              (effort) => effort.reasoningEffort,
            ),
            defaultReasoningEffort: model.defaultReasoningEffort,
            serviceTiers:
              model.serviceTiers?.map((tier) => (tier.id === 'priority' ? 'fast' : tier.id)) ??
              model.additionalSpeedTiers,
          })),
        );
        cursor = page.nextCursor;
      }
      this.titles?.configure(
        account.account?.type === 'chatgpt',
        this.state.models.map((model) => model.id),
      );
      this.state.ready = true;
      this.state.connection = 'ready';
      this.state.capabilities = CAPABILITIES.filter((method) => !this.disabled.has(method));
      this.publishRuntime();
    } catch (error) {
      const failure = asCodexError(error);
      this.state.ready = false;
      this.state.connection = 'unavailable';
      this.state.error = failure.message;
      this.publishRuntime();
      await this.stopProcess(failure);
      this.scheduleRestart();
      throw failure;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    await this.starting?.catch(() => {});
    await this.recovering;
    await this.stopProcess();
  }
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.restartAttempt++, 5), 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.recovering = (async () => {
        await this.stopProcess();
        if (this.stopped) return;
        try {
          await this.start();
          this.restartAttempt = 0;
        } catch {
          this.scheduleRestart();
        }
      })();
      void this.recovering.finally(() => {
        this.recovering = undefined;
      });
    }, delay);
    this.restartTimer.unref();
  }
  private async stopProcess(
    reason = new CodexError('CODEX_UNAVAILABLE', 'Codex connection closed by this service', true),
  ): Promise<void> {
    const child = this.child;
    this.state.ready = false;
    this.state.connection = 'unavailable';
    this.expireActions();
    this.rpc?.fail(reason);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => child.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
      const done = setTimeout(() => {
        cleanup();
        resolve();
      }, 3500);
      const cleanup = () => {
        clearTimeout(term);
        clearTimeout(kill);
        clearTimeout(done);
      };
      child.once('exit', () => {
        cleanup();
        resolve();
      });
    });
    if (this.child === child) this.child = undefined;
  }
  private async call<M extends keyof Responses>(
    method: M,
    params: Extract<ClientRequest, { method: M }>['params'],
    initializing = false,
    timeoutMs?: number,
  ): Promise<Responses[M]> {
    if (!this.rpc || (!initializing && !this.ready))
      throw new CodexError('CODEX_UNAVAILABLE', 'Codex is not ready');
    if (this.disabled.has(method))
      throw new CodexError('PROTOCOL_INCOMPATIBLE', `Codex does not support ${method}`);
    try {
      return await this.rpc.request<Responses[M]>(method, params, undefined, timeoutMs);
    } catch (error) {
      // Concurrent startup calls can inherit the same error when cleanup fails the transport.
      if (!initializing && error instanceof CodexError && error.rpcCode === -32601) {
        this.disabled.add(method);
        this.state.capabilities = this.state.capabilities.filter((name) => name !== method);
        this.state.error = `当前 Codex 缺少 ${method} 能力`;
        this.publishRuntime();
      }
      throw error;
    }
  }
  private validateSettings(settings: Settings = {}): void {
    const model =
      settings.model === undefined
        ? undefined
        : this.state.models.find((entry) => entry.id === settings.model);
    if (settings.model !== undefined && !model)
      throw new AppError('VALIDATION_ERROR', '模型不在当前 Codex 模型列表中');
    if (
      settings.reasoningEffort !== undefined &&
      !(
        model?.reasoningEfforts ?? this.state.models.flatMap((entry) => entry.reasoningEfforts)
      ).includes(settings.reasoningEffort)
    )
      throw new AppError('VALIDATION_ERROR', '所选推理强度不受当前模型支持');
  }
  async listThreads(
    cwd: string | string[],
    cursor?: string,
    archived = false,
  ): Promise<ThreadPage> {
    const sequence = ++this.archiveSequence;
    const result = await this.call('thread/list', {
      cwd,
      cursor,
      limit: 30,
      archived,
      sourceKinds: ['cli', 'appServer', 'vscode'],
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    return {
      data: result.data.map((thread) => ({
        ...mapThread(thread),
        archived: this.observeArchive(thread.id, archived, sequence),
      })),
      nextCursor: result.nextCursor,
    };
  }

  private observeArchive(id: string, archived: boolean, sequence: number): boolean {
    const current = this.archives.get(id);
    if (current && current.sequence > sequence) return current.archived;
    this.archives.set(id, { archived, sequence });
    return archived;
  }

  private archiveChanged(id: string, archived: boolean): void {
    this.observeArchive(id, archived, ++this.archiveSequence);
    this.emit({ type: 'threadArchive', threadId: id, archived });
  }

  /** thread/read has no archive field. Query the native index, including paginated history,
   * instead of guessing from the unstable rollout path or maintaining a second database. */
  private async storedThread(thread: Thread, sequence: number): Promise<ThreadView> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let archived = false;
    do {
      const page: ThreadListResponse = await this.call('thread/list', {
        archived: true,
        cwd: thread.cwd,
        cursor,
        limit: 100,
        sourceKinds: [
          'cli',
          'vscode',
          'exec',
          'appServer',
          'subAgent',
          'subAgentReview',
          'subAgentCompact',
          'subAgentThreadSpawn',
          'subAgentOther',
          'unknown',
        ],
      });
      if (page.data.some((entry) => entry.id === thread.id)) {
        archived = true;
        break;
      }
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid archive pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { ...mapThread(thread), archived: this.observeArchive(thread.id, archived, sequence) };
  }

  /** Native archive also shuts down spawned descendants, even already-archived ones. */
  private async assertArchiveIdle(rootId: string): Promise<void> {
    const threads = new Map<string, Thread>();
    const read = async (id: string): Promise<Thread> => {
      let thread = threads.get(id);
      if (!thread) {
        thread = (await this.call('thread/read', { threadId: id, includeTurns: false })).thread;
        threads.set(id, thread);
      }
      return thread;
    };
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: ThreadLoadedListResponse = await this.call('thread/loaded/list', {
        cursor,
        limit: 100,
      });
      for (const id of page.data) {
        let thread: Thread;
        try {
          thread = await read(id);
        } catch (error) {
          // A completed helper can unload after the loaded-thread snapshot.
          if (
            error instanceof CodexError &&
            error.rpcCode === -32600 &&
            error.message === `thread not loaded: ${id}`
          )
            continue;
          throw error;
        }
        if (thread.status.type !== 'active') continue;
        const ancestors = new Set<string>();
        for (;;) {
          if (thread.id === rootId)
            throw new AppError('THREAD_BUSY', '会话或其子任务仍在运行，结束后才能归档', 409);
          if (!thread.parentThreadId) break;
          if (ancestors.has(thread.id))
            throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid thread ancestry');
          ancestors.add(thread.id);
          thread = await read(thread.parentThreadId);
        }
      }
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid loaded thread pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  async renameThread(id: string, name: string): Promise<void> {
    const problem = threadNameError(name);
    if (problem) throw new AppError('VALIDATION_ERROR', problem);
    const epoch = this.epoch;
    // A generated name may already be on the wire. Finish it before the explicit write.
    await this.titles?.prepareManualName(id);
    if (this.epoch !== epoch || !this.ready)
      throw new CodexError(
        'CODEX_UNAVAILABLE',
        '重命名等待期间 Codex 实例已变化，请核对名称',
        true,
      );
    await this.call('thread/name/set', { threadId: id, name: name.trim() });
  }

  async archiveThread(id: string): Promise<void> {
    await this.assertArchiveIdle(id);
    await this.call('thread/archive', { threadId: id });
    this.archiveChanged(id, true);
  }

  async unarchiveThread(id: string): Promise<ThreadView> {
    const { thread } = await this.call('thread/unarchive', { threadId: id });
    this.archiveChanged(id, false);
    return { ...mapThread(thread), archived: false };
  }
  private async readThreadHeader(id: string): Promise<Thread> {
    try {
      return (await this.call('thread/read', { threadId: id, includeTurns: false })).thread;
    } catch (error) {
      if (
        error instanceof CodexError &&
        error.rpcCode === -32600 &&
        error.message === `thread not loaded: ${id}`
      )
        throw new AppError('THREAD_NOT_FOUND', '会话尚未保存或已不存在', 404, { threadId: id });
      throw error;
    }
  }

  async readThreadMetadata(id: string): Promise<ThreadView> {
    const sequence = ++this.archiveSequence;
    return this.storedThread(await this.readThreadHeader(id), sequence);
  }
  async readThreadPage(id: string, continuation?: string): Promise<ThreadView> {
    const epoch = this.epoch;
    let cursor: string | null = null;
    if (continuation) {
      try {
        const decoded = JSON.parse(Buffer.from(continuation, 'base64url').toString('utf8'));
        if (
          decoded.threadId !== id ||
          decoded.epoch !== epoch ||
          typeof decoded.cursor !== 'string'
        )
          throw new Error('Invalid cursor');
        cursor = decoded.cursor;
      } catch {
        throw new AppError('HISTORY_CURSOR_EXPIRED', '历史分页已失效，请重新同步会话。', 409);
      }
    }
    const sequence = ++this.archiveSequence;
    const header = await this.readThreadHeader(id);
    // Legacy rollout files expose no paging protocol. Keep the compatibility path explicit.
    if (header.historyMode !== 'paginated') return this.readThread(id);
    const page = await this.call('thread/turns/list', {
      threadId: id,
      cursor,
      limit: 12,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    if (page.nextCursor && page.nextCursor === cursor)
      throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid turn pagination');
    await this.hydrateTurns(id, page.data);
    if (this.epoch !== epoch)
      throw new AppError('HISTORY_CURSOR_EXPIRED', '读取期间 Codex 已重启，请重新同步会话。', 409);
    const view = await this.storedThread(
      { ...header, turns: page.data.slice().reverse() },
      sequence,
    );
    return {
      ...view,
      history: {
        olderCursor: page.nextCursor
          ? Buffer.from(
              JSON.stringify({
                threadId: id,
                epoch,
                cursor: page.nextCursor,
              }),
            ).toString('base64url')
          : null,
      },
    };
  }

  private async hydrateTurns(id: string, turns: Thread['turns']): Promise<void> {
    for (const turn of turns) {
      if (turn.itemsView === 'full') continue;
      let cursor: string | null = null;
      const seen = new Set<string>();
      turn.items = [];
      do {
        const page: ThreadItemsListResponse = await this.call('thread/items/list', {
          threadId: id,
          turnId: turn.id,
          cursor,
          limit: 20,
          sortDirection: 'asc',
        });
        turn.items.push(...page.data.map((entry) => entry.item));
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 1000))
          throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid item pagination');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
  }

  async readThread(id: string): Promise<ThreadView> {
    const sequence = ++this.archiveSequence;
    const thread = await this.readThreadHeader(id);
    if (thread.historyMode !== 'paginated')
      return this.storedThread(
        (await this.call('thread/read', { threadId: id, includeTurns: true })).thread,
        sequence,
      );
    let cursor: string | null = null;
    const seen = new Set<string>();
    thread.turns = [];
    do {
      const page: ThreadTurnsListResponse = await this.call('thread/turns/list', {
        threadId: id,
        cursor,
        limit: 100,
        sortDirection: 'asc',
        itemsView: 'summary',
      });
      for (const turn of page.data) {
        if (turn.itemsView !== 'full') {
          let itemCursor: string | null = null;
          const itemSeen = new Set<string>();
          turn.items = [];
          do {
            const items: ThreadItemsListResponse = await this.call('thread/items/list', {
              threadId: id,
              turnId: turn.id,
              cursor: itemCursor,
              limit: 20,
              sortDirection: 'asc',
            });
            turn.items.push(...items.data.map((entry) => entry.item));
            itemCursor = items.nextCursor;
            if (itemCursor && (itemSeen.has(itemCursor) || itemSeen.size >= 1000))
              throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid item pagination');
            if (itemCursor) itemSeen.add(itemCursor);
          } while (itemCursor);
        }
      }
      thread.turns.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid turn pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return this.storedThread(thread, sequence);
  }
  async createThread(cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    await this.validatePermissionSettings(cwd, settings);
    const titles = this.titles;
    const result = await this.call('thread/start', { cwd, ...threadSettings(settings) });
    this.tokenUsage.created(result.thread.id);
    titles?.register(result);
    return {
      ...mapThread(result.thread),
      runtimeSettings: await this.responseRuntimeSettings(result),
    };
  }
  async saveModelDefaults(settings: ModelDefaults): Promise<ModelDefaultsResult> {
    this.validateSettings({
      model: settings.model,
      ...(settings.reasoningEffort === null ? {} : { reasoningEffort: settings.reasoningEffort }),
    });
    // Match the CLI picker: write a complete pair to the owning server's user/profile config.
    // No file path or permission fields can be supplied by the browser.
    const result = await this.call('config/batchWrite', {
      edits: [
        { keyPath: 'model', value: settings.model, mergeStrategy: 'replace' },
        {
          keyPath: 'model_reasoning_effort',
          value: settings.reasoningEffort,
          mergeStrategy: 'replace',
        },
      ],
      reloadUserConfig: true,
    });
    return { status: result.status };
  }
  async readRuntimeSettings(cwd: string): Promise<RuntimeSettings> {
    const { config } = await this.call('config/read', { cwd, includeLayers: false });
    // Config can contain credentials and instructions. Only displayable fields cross the gateway.
    return {
      model: typeof config.model === 'string' ? config.model : null,
      reasoningEffort:
        typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : null,
      ...serviceTierSettings(config.service_tier),
      sandbox: config.sandbox_mode ?? null,
      approvalPolicy:
        typeof config.approval_policy === 'string'
          ? config.approval_policy
          : config.approval_policy
            ? 'granular'
            : null,
      approvalReviewer: config.approvals_reviewer ?? null,
      networkAccess:
        config.sandbox_mode === 'workspace-write'
          ? (config.sandbox_workspace_write?.network_access ?? null)
          : null,
      permissionMode:
        typeof config.default_permissions === 'string' &&
        ![':workspace', ':read-only', ':danger-full-access'].includes(config.default_permissions)
          ? 'custom'
          : null,
      permissionProfile:
        typeof config.default_permissions === 'string'
          ? { id: config.default_permissions, extends: null }
          : null,
      writableRoots: config.sandbox_workspace_write?.writable_roots ?? null,
      excludeTmpdirEnvVar: config.sandbox_workspace_write?.exclude_tmpdir_env_var ?? null,
      excludeSlashTmp: config.sandbox_workspace_write?.exclude_slash_tmp ?? null,
      permissionCapabilities: await this.readPermissionCapabilities(undefined, config),
    };
  }
  private async readPermissionCapabilities(
    threadId?: string,
    config?: ConfigReadResponse['config'],
  ): Promise<PermissionCapabilities> {
    if (!CODEX_COMPATIBILITY.verified.includes(this.state.codexVersion ?? ''))
      return permissionCapabilities(
        null,
        false,
        `权限模式仅核验过 Codex ${VERIFIED_CODEX_VERSION}；当前版本 ${this.state.codexVersion ?? '未知'}`,
      );
    try {
      const [requirements, first] = await Promise.all([
        this.call('configRequirements/read', undefined),
        this.call('experimentalFeature/list', { limit: 200, ...(threadId ? { threadId } : {}) }),
      ]);
      if (!Object.hasOwn(requirements, 'requirements') || !Array.isArray(first.data))
        throw new Error('Permission capability response is incomplete');
      const features = [...first.data];
      let cursor = first.nextCursor;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 100) throw new Error('Invalid feature pagination');
        seen.add(cursor);
        const page = await this.call('experimentalFeature/list', {
          limit: 200,
          cursor,
          ...(threadId ? { threadId } : {}),
        });
        features.push(...page.data);
        cursor = page.nextCursor;
      }
      const configFeatures = config?.features;
      const explicit = isRecord(configFeatures) ? configFeatures.guardian_approval : undefined;
      const autoReview =
        typeof explicit === 'boolean'
          ? explicit
          : features.find((entry) => entry.name === 'guardian_approval')?.enabled === true;
      return permissionCapabilities(
        requirements.requirements as PermissionRequirements | null,
        autoReview,
      );
    } catch {
      return permissionCapabilities(
        null,
        false,
        '无法核实当前 Codex 的功能和受管要求，请重试或检查版本支持',
      );
    }
  }
  private async validatePermissionSettings(
    cwd: string,
    settings?: Settings,
    threadId?: string,
  ): Promise<void> {
    if (!settings?.permissionMode && settings?.approvalReviewer === undefined) return;
    const epoch = this.epoch;
    const defaults =
      !threadId || !this.permissionState.has(threadId)
        ? await this.readRuntimeSettings(cwd)
        : undefined;
    const capabilities = defaults
      ? defaults.permissionCapabilities
      : await this.readPermissionCapabilities(threadId);
    if (epoch !== this.epoch)
      throw new AppError('CODEX_UNAVAILABLE', 'Codex 运行实例已变化，请重试');
    const model =
      settings.model ??
      (threadId ? this.permissionState.get(threadId)?.model : undefined) ??
      defaults?.model;
    const reason = settings.permissionMode
      ? permissionModeUnavailable(settings.permissionMode, capabilities, model)
      : permissionReviewerUnavailable(settings.approvalReviewer!, capabilities, model);
    if (reason) throw new AppError('PERMISSION_MODE_UNAVAILABLE', reason);
  }
  private async responseRuntimeSettings(result: ThreadStartResponse): Promise<RuntimeSettings> {
    const previous = this.permissionState.get(result.thread.id);
    const settings: RuntimeSettings = {
      model: result.model ?? result.thread.model ?? null,
      ...reportedCollaborationMode(
        (result as ThreadStartResponse & CollaborationProvenance).collaborationMode,
      ),
      reasoningEffort: result.reasoningEffort ?? null,
      ...serviceTierSettings(result.serviceTier),
      ...permissionSettings(
        result.sandbox,
        result.approvalPolicy,
        result.approvalsReviewer,
        (result as ThreadStartResponse & ProfileProvenance).activePermissionProfile,
        result.cwd,
      ),
      permissionCapabilities: await this.readPermissionCapabilities(result.thread.id),
    };
    const latest = this.permissionState.get(result.thread.id);
    const confirmed =
      latest && latest !== previous
        ? { ...latest, permissionCapabilities: settings.permissionCapabilities }
        : settings;
    this.permissionState.set(result.thread.id, confirmed);
    // The service correctly keeps a newer settings notification over a lifecycle response.
    // Publish availability alongside that newer state so the delayed capability read is not lost.
    if (confirmed !== settings)
      this.emit({ type: 'threadSettings', threadId: result.thread.id, settings: confirmed });
    return settings;
  }
  async resumeThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    await this.validatePermissionSettings(cwd, settings, id);
    const titles = this.titles;
    let result: ThreadResumeResponse;
    try {
      result = await this.call('thread/resume', {
        threadId: id,
        cwd,
        ...threadSettings(settings),
        excludeTurns: true,
      });
    } catch (error) {
      // Verified with two 0.164.0 processes, for both legacy and paginated histories.
      // -32600 alone covers many failures; match this thread's writer conflict exactly.
      if (
        error instanceof CodexError &&
        error.rpcCode === -32600 &&
        error.message === `thread ${id} already has an active writer`
      )
        throw new AppError('THREAD_IN_USE', '此会话正被其他进程使用', 409, { threadId: id });
      throw error;
    }
    titles?.register(result);
    const view = await this.readThreadPage(result.thread.id);
    return { ...view, runtimeSettings: await this.responseRuntimeSettings(result) };
  }
  async forkThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    await this.validatePermissionSettings(cwd, settings, id);
    const titles = this.titles;
    const result = await this.call('thread/fork', {
      threadId: id,
      cwd,
      ...threadSettings(settings),
      // Omitting lastTurnId copies the persisted history, including an active turn's
      // interruption marker in the fork. The source is never resumed or interrupted.
      excludeTurns: true,
    });
    let forkedId: string | undefined;
    try {
      if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === 'string')
        forkedId = result.thread.id === id ? undefined : result.thread.id;
      const metadata = mapThread(result.thread);
      if (metadata.id === id)
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex fork returned the source thread ID');
      forkedId = metadata.id;
      const thread = await this.readThread(forkedId);
      if (thread.id !== forkedId)
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex returned a different fork thread ID');
      titles?.register(result);
      return { ...thread, runtimeSettings: await this.responseRuntimeSettings(result) };
    } catch (error) {
      const failure = asCodexError(error);
      // The mutating RPC already succeeded. A read failure cannot make a retry safe.
      throw new CodexError(
        failure.code,
        forkedId
          ? `已创建分支会话 ${forkedId}，但无法加载历史；请从会话列表重新打开，不要重复 fork。${failure.message}`
          : `Codex fork 已返回结果，但无法确认新会话；请检查会话列表，不要重复 fork。${failure.message}`,
        true,
        failure.rpcCode,
      );
    }
  }
  async startTurn(
    id: string,
    cwd: string,
    text: string,
    settings?: Settings,
    images?: string[],
  ): Promise<TurnView> {
    this.validateSettings(settings);
    await this.validatePermissionSettings(cwd, settings, id);
    const turn = mapTurn(
      id,
      (
        await this.call('turn/start', {
          threadId: id,
          cwd,
          input: taskInput(text, images),
          ...turnSettings(cwd, settings),
          ...collaborationSelection(settings, this.permissionState.get(id)),
        })
      ).turn,
    );
    return turn;
  }
  async startReview(
    id: string,
    target: ReviewTarget = { type: 'uncommittedChanges' },
  ): Promise<TurnView> {
    const result = await this.call('review/start', {
      threadId: id,
      target: target.type === 'commit' ? { ...target, title: null } : target,
      delivery: 'inline',
    });
    if (!isRecord(result) || result.reviewThreadId !== id)
      throw new CodexError(
        'PROTOCOL_INCOMPATIBLE',
        'Codex review returned a different thread; review result needs reconciliation',
        true,
      );
    return mapTurn(id, result.turn);
  }
  steerTurn(
    id: string,
    turnId: string,
    text: string,
    images?: string[],
  ): Promise<TurnSteerResponse> {
    return this.call('turn/steer', {
      threadId: id,
      expectedTurnId: turnId,
      input: taskInput(text, images),
    });
  }
  async interruptTurn(id: string, turnId: string): Promise<void> {
    await this.call('turn/interrupt', { threadId: id, turnId });
  }

  async recapThread(id: string, prompt: string) {
    if (!this.titles) throw new CodexError('CODEX_UNAVAILABLE', 'Codex unavailable');
    return this.titles.recap(id, prompt);
  }
  listGuardianDenials(id: string) {
    return this.denials.list(id);
  }
  async approveGuardianDenial(id: string, denialId: string): Promise<void> {
    const event = this.denials.take(id, denialId);
    await this.call('thread/approveGuardianDeniedAction', { threadId: id, event });
  }
  async compactThread(id: string): Promise<void> {
    // The empty response acknowledges dispatch, not completion. Turn notifications
    // carry the compaction's identity and final outcome.
    await this.call('thread/compact/start', { threadId: id });
  }

  async executeCommand(
    processId: string,
    cwd: string,
    command: string,
    output: Parameters<NonNullable<CodexClient['executeCommand']>>[3],
  ) {
    this.commandOutputs.set(processId, output);
    try {
      return await this.call(
        'command/exec',
        {
          processId,
          cwd,
          command:
            process.platform === 'win32'
              ? ['cmd.exe', '/d', '/s', '/c', command]
              : ['/bin/sh', '-c', command],
          streamStdoutStderr: true,
          streamStdin: false,
          tty: false,
          timeoutMs: SHELL_TIMEOUT_MS,
          outputBytesCap: SHELL_OUTPUT_BYTES / 2,
          // Omit sandboxPolicy: preserve the server's configured permission policy.
        },
        false,
        SHELL_TIMEOUT_MS + 5000,
      );
    } finally {
      this.commandOutputs.delete(processId);
    }
  }
  async terminateCommand(processId: string): Promise<void> {
    await this.call('command/exec/terminate', { processId });
  }

  private notification(message: RpcNotification): void {
    if (this.titles?.notification(message)) return;
    const event = message as ServerNotification;
    const p = event.params;
    switch (event.method) {
      case 'command/exec/outputDelta': {
        const { processId, stream, deltaBase64, capReached } = event.params;
        this.commandOutputs.get(processId)?.(
          stream,
          Buffer.from(deltaBase64, 'base64'),
          capReached,
        );
        break;
      }
      case 'thread/settings/updated':
        {
          const observed: RuntimeSettings = {
            ...reportedCollaborationMode(
              (
                event.params.threadSettings as typeof event.params.threadSettings &
                  CollaborationProvenance
              ).collaborationMode,
            ),
            model: event.params.threadSettings.model ?? null,
            reasoningEffort: event.params.threadSettings.effort ?? null,
            ...serviceTierSettings(event.params.threadSettings.serviceTier),
            ...permissionSettings(
              event.params.threadSettings.sandboxPolicy,
              event.params.threadSettings.approvalPolicy,
              event.params.threadSettings.approvalsReviewer,
              event.params.threadSettings.activePermissionProfile,
              event.params.threadSettings.cwd,
            ),
            permissionCapabilities: this.permissionState.get(event.params.threadId)
              ?.permissionCapabilities,
          };
          this.permissionState.set(event.params.threadId, observed);
          this.emit({
            type: 'threadSettings',
            threadId: event.params.threadId,
            settings: observed,
          });
        }
        break;
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
        if (event.method === 'item/autoApprovalReview/completed') this.denials.record(event.params);
        this.emit({
          type: 'autoReview',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          review: mapAutoReview(event.params),
        });
        break;
      case 'thread/started':
        this.emit({ type: 'thread', thread: mapThread(event.params.thread) });
        break;
      case 'thread/archived':
        this.archiveChanged(event.params.threadId, true);
        break;
      case 'thread/unarchived':
        this.archiveChanged(event.params.threadId, false);
        break;
      case 'thread/name/updated':
        this.emit({
          type: 'threadName',
          threadId: event.params.threadId,
          name: event.params.threadName,
        });
        break;
      case 'thread/status/changed':
        this.emit({
          type: 'threadStatus',
          threadId: event.params.threadId,
          status: threadStatus(event.params.status),
        });
        break;
      case 'turn/started':
      case 'turn/completed': {
        const { threadId, turn } = event.params;
        if (event.method === 'turn/started') this.tokenUsage.started(threadId, turn.id);
        const outputTokens =
          event.method === 'turn/completed'
            ? this.tokenUsage.completed(threadId, turn.id)
            : undefined;
        this.emit({
          type: 'turn',
          threadId,
          turn: {
            ...mapTurn(threadId, turn),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        });
        if (event.method === 'turn/completed')
          this.expireActions(event.params.threadId, event.params.turn.id);
        break;
      }
      case 'thread/tokenUsage/updated':
        this.tokenUsage.updated(
          event.params.threadId,
          event.params.turnId,
          event.params.tokenUsage?.total?.outputTokens,
        );
        break;
      case 'thread/compacted':
        this.tokenUsage.compacted(event.params.threadId, event.params.turnId);
        this.emit({ type: 'compactionCompleted', ...event.params });
        break;
      case 'item/started':
      case 'item/completed':
        if (event.params.item.type === 'contextCompaction')
          this.tokenUsage.compacted(event.params.threadId, event.params.turnId);
        if (['agentMessage', 'plan', 'reasoning'].includes(event.params.item.type))
          this.emit({
            type: 'turnProgress',
            threadId: event.params.threadId,
            turnId: event.params.turnId,
          });
        this.emit({
          type: 'item',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          item: {
            ...mapItem(event.params.item),
            ...(event.params.item.type === 'contextCompaction'
              ? { status: event.method === 'item/started' ? 'inProgress' : 'completed' }
              : {}),
          },
        });
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        // Background tool output can continue while the model stream is retrying.
        // Only model content proves that this turn's upstream stream resumed.
        if (!event.method.includes('outputDelta'))
          this.emit({
            type: 'turnProgress',
            threadId: event.params.threadId,
            turnId: event.params.turnId,
          });
        this.emit({
          type: 'delta',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          itemId: event.params.itemId,
          field: event.method.includes('outputDelta') ? 'output' : 'text',
          delta: event.params.delta,
          itemType: event.method.split('/')[1]!,
        });
        break;
      case 'item/reasoning/summaryPartAdded':
      case 'rawResponse/completed':
        this.emit({
          type: 'turnProgress',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
        });
        break;
      case 'turn/diff/updated':
        this.emit({
          type: 'diff',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          diff: event.params.diff,
        });
        break;
      case 'item/fileChange/patchUpdated':
        this.emit({
          type: 'item',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          item: mapItem({
            type: 'fileChange',
            id: event.params.itemId,
            changes: event.params.changes,
            status: 'inProgress',
          }),
        });
        break;
      case 'serverRequest/resolved': {
        const actionId = this.actionIds.get(event.params.requestId);
        if (actionId) {
          this.emit({ type: 'actionResolved', actionId });
          this.actions.delete(actionId);
          this.actionIds.delete(event.params.requestId);
        }
        break;
      }
      case 'error':
        // Upstream retries/failures belong to a turn, not to the app-server process.
        this.emit({
          type: 'turnError',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          message: event.params.error.message,
          willRetry: event.params.willRetry,
          ...mapTurnError(event.params.error),
        });
        break;
      default: // Unknown noninteractive notifications cannot authorize any action.
        if (!isRecord(p)) break;
    }
  }
  private async serverRequest(message: RpcServerRequest): Promise<void> {
    if (isRecord(message.params) && this.titles?.isInternal(message.params.threadId)) {
      await this.rpc?.reject(
        message.id,
        -32601,
        'Interactive tools are disabled for isolated helper requests',
      );
      return;
    }
    const request = message as ServerRequest;
    const params: Record<string, unknown> = isRecord(message.params) ? message.params : {};
    const action: PendingAction = {
      actionId: randomUUID(),
      codexEpoch: this.epoch,
      rpcId: message.id,
      kind: 'unsupported',
      status: 'pending',
      title: '不支持的 Codex 交互请求',
      options: [],
      ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    };
    const decisions = new Map<string, CommandExecutionApprovalDecision>();
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      for (const [id, label] of [
        ['accept', '允许本次'],
        ['acceptForSession', '本会话允许'],
        ['decline', '拒绝'],
        ['cancel', '取消当前任务'],
      ] as const) {
        action.options.push({ id, label });
        decisions.set(id, id);
      }
      action.reason = request.params.reason ?? undefined;
      if (request.method === 'item/commandExecution/requestApproval') {
        const p = request.params;
        action.kind = p.networkApprovalContext ? 'network' : 'command';
        action.title = p.networkApprovalContext
          ? `网络权限：${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`
          : '命令审批';
        action.command = p.command ?? undefined;
        action.cwd = p.cwd ?? undefined;
        action.details = {
          kind: p.kind,
          network: p.networkApprovalContext,
          commandActions: p.commandActions,
        };
        if (p.proposedExecpolicyAmendment) {
          action.options.push({
            id: 'acceptWithRule',
            label: `允许并记住命令规则：${p.proposedExecpolicyAmendment.join(' ')}`,
          });
          decisions.set('acceptWithRule', {
            acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment },
          });
        }
        p.proposedNetworkPolicyAmendments?.forEach((amendment, index) => {
          const id = `networkRule:${index}`;
          action.options.push({ id, label: `应用网络规则：${JSON.stringify(amendment)}` });
          decisions.set(id, {
            applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
          });
        });
      } else {
        action.kind = 'file';
        action.title = '文件变更审批';
        action.details = { itemId: request.params.itemId, grantRoot: request.params.grantRoot };
      }
    } else if (request.method === 'item/permissions/requestApproval') {
      const p = request.params;
      action.kind = 'permissions';
      action.title = '额外权限审批';
      action.reason = p.reason ?? undefined;
      action.cwd = p.cwd;
      action.options = [
        { id: 'accept', label: '当前任务允许' },
        { id: 'acceptForSession', label: '本会话允许' },
        { id: 'decline', label: '拒绝' },
      ];
      action.permissionRequest = {
        ...(p.permissions.network === null ? {} : { network: p.permissions.network.enabled }),
        ...(p.permissions.fileSystem === null
          ? {}
          : {
              fileSystem: {
                read: p.permissions.fileSystem.read ?? [],
                write: p.permissions.fileSystem.write ?? [],
                entries: (p.permissions.fileSystem.entries ?? []).map((entry) => ({
                  path: permissionPathLabel(entry.path),
                  access: entry.access,
                })),
                ...(p.permissions.fileSystem.globScanMaxDepth === undefined
                  ? {}
                  : {
                      globScanMaxDepth: p.permissions.fileSystem.globScanMaxDepth,
                    }),
              },
            }),
      };
      action.details = {
        itemId: p.itemId,
        environmentId: p.environmentId,
        permissions: p.permissions,
      };
    } else if (request.method === 'mcpServer/elicitation/request') {
      action.kind = 'elicitation';
      action.reason = request.params.message;
      action.elicitation = normalizeElicitationRequest(params);
      action.title = `${action.elicitation.approval ? 'MCP 工具审批' : 'MCP 交互'}：${request.params.serverName}`;
      action.options = [
        {
          id: 'accept',
          label: action.elicitation.approval
            ? '允许本次'
            : action.elicitation.mode === 'url'
              ? '已完成，继续'
              : '提交',
        },
        ...(action.elicitation.approval?.allowSession
          ? [{ id: 'acceptSession', label: '本会话允许' }]
          : []),
        { id: 'decline', label: '拒绝' },
        { id: 'cancel', label: '取消' },
      ];
      // Keep an unsupported schema reviewable while allowing an explicit decline/cancel.
      if (action.elicitation.schemaError)
        action.details = { requestedSchema: params.requestedSchema, mode: params.mode };
    } else if (request.method === 'item/tool/requestUserInput') {
      action.kind = 'questions';
      action.title = '需要你的回答';
      action.blocking = request.params.isBlocking;
      action.questions = request.params.questions.map((question) => ({
        ...question,
        options: question.options ?? [],
      }));
    } else {
      action.status = 'expired';
      action.reason = `当前 Web UI 尚未实现 ${message.method}`;
      this.emit({ type: 'action', action });
      this.state.error = action.reason;
      this.publishRuntime();
      await this.rpc!.reject(
        message.id,
        -32601,
        `Unsupported interactive request: ${message.method}`,
      );
      return;
    }
    this.actions.set(action.actionId, { action, request, decisions, responding: false });
    this.actionIds.set(message.id, action.actionId);
    this.emit({ type: 'action', action: structuredClone(action) });
  }
  async respond(actionId: string, resolution: ActionResolution): Promise<void> {
    const context = this.actions.get(actionId);
    if (!context || context.action.codexEpoch !== this.epoch || !this.ready)
      throw new AppError('ACTION_EXPIRED', '此人工请求已失效', 409);
    if (context.responding) throw new AppError('ACTION_CONFLICT', '此人工请求已提交回答', 409);
    let response:
      | ToolRequestUserInputResponse
      | CommandExecutionRequestApprovalResponse
      | FileChangeRequestApprovalResponse
      | PermissionsRequestApprovalResponse
      | McpServerElicitationRequestResponse;
    if (context.request.method === 'item/permissions/requestApproval') {
      const decision = validatePermissionResolution(resolution);
      const requested = context.request.params.permissions;
      response = {
        permissions:
          decision === 'decline'
            ? {}
            : structuredClone({
                ...(requested.network === null ? {} : { network: requested.network }),
                ...(requested.fileSystem === null ? {} : { fileSystem: requested.fileSystem }),
              }),
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    } else if (context.request.method === 'mcpServer/elicitation/request') {
      const content = validateElicitationResolution(
        normalizeElicitationRequest({ ...context.request.params }),
        resolution,
      );
      response = {
        action: (resolution as { decision: 'accept' | 'decline' | 'cancel' }).decision,
        content,
        _meta:
          'decision' in resolution && resolution.persist === 'session'
            ? { persist: 'session' }
            : null,
      };
    } else if (context.request.method === 'item/tool/requestUserInput') {
      if (!('answers' in resolution))
        throw new AppError('VALIDATION_ERROR', '此请求需要结构化回答');
      const questions = context.request.params.questions;
      const ids = new Set(questions.map((question) => question.id));
      if (Object.keys(resolution.answers).some((id) => !ids.has(id)))
        throw new AppError('VALIDATION_ERROR', '回答包含未知题目');
      const answers: ToolRequestUserInputResponse['answers'] = {};
      for (const question of questions) {
        const values = resolution.answers[question.id];
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.some((value) => typeof value !== 'string' || !value.trim())
        )
          throw new AppError('VALIDATION_ERROR', `请回答 ${question.header}`);
        if (
          question.options?.length &&
          !question.isOther &&
          values.some((value) => !question.options!.some((option) => option.label === value))
        )
          throw new AppError('VALIDATION_ERROR', `题目 ${question.header} 只接受所列选项`);
        answers[question.id] = { answers: values };
      }
      response = { answers };
    } else {
      if (
        !('decision' in resolution) ||
        'content' in resolution ||
        'persist' in resolution ||
        !context.decisions.has(resolution.decision)
      )
        throw new AppError('VALIDATION_ERROR', '此请求不支持所提交的决定');
      response = { decision: context.decisions.get(resolution.decision)! };
    }
    context.responding = true;
    try {
      await this.rpc!.respond(context.action.rpcId, response);
    } catch (error) {
      if (error instanceof CodexError && !error.uncertain) context.responding = false;
      throw error;
    }
  }
  private expireActions(threadId?: string, turnId?: string): void {
    for (const [id, context] of this.actions) {
      if (threadId && context.action.threadId !== threadId) continue;
      if (turnId && context.action.turnId !== turnId) continue;
      this.emit({ type: 'action', action: { ...context.action, status: 'expired' } });
      this.actions.delete(id);
      this.actionIds.delete(context.action.rpcId);
    }
  }
}

import { t } from '../i18n';
import { api, HttpError } from './api';
import { applyThreadPatch, type ThreadPatch } from '../../shared/thread-patch';
import type {
  Cursor,
  Operation,
  Project,
  ServerMessage,
  SystemInfo,
  ThreadSummary,
  ThreadView,
  TurnCompletion,
  AttentionRequest,
} from '../../shared/types';

export type ConnectionState =
  'connecting' | 'connected' | 'disconnected' | 'authenticationRequired';
export interface Projection {
  data: ThreadView;
  cursor: Cursor;
}

/** The cache owns both projection and cursor; cursors are deliberately never written to storage. */
export class ProjectionCache {
  private readonly threads = new Map<string, Projection>();
  private readonly summaryCursors = new Map<string, Cursor>();
  private runtimeCursor: Cursor | undefined;
  private projectsCursor: Cursor | undefined;
  get(threadId: string) {
    return this.threads.get(threadId);
  }
  advance(threadId: string, cursor: Cursor, threadSeq: number) {
    const entry = this.threads.get(threadId);
    if (entry?.cursor.serverEpoch !== cursor.serverEpoch || entry.cursor.seq < threadSeq)
      return false;
    if (entry.cursor.seq < cursor.seq) this.threads.set(threadId, { ...entry, cursor });
    return true;
  }
  invalidateDetail(threadId: string) {
    // Keep overview ordering; only the next detail subscription needs a fresh snapshot.
    this.threads.delete(threadId);
  }
  removeProject(projectId: string) {
    for (const [id, entry] of this.threads) {
      if (entry.data.projectId !== projectId) continue;
      this.threads.delete(id);
      this.summaryCursors.delete(id);
    }
  }
  apply(message: ServerMessage): boolean {
    if (message.type === 'error') return true;
    if (message.type === 'resync' || message.type === 'subscribed') return true;
    // Live signals do not establish or advance any snapshot/replay cursor.
    if (message.type === 'event' && ['turnCompletion', 'attentionRequest'].includes(message.kind))
      return true;
    if (message.type === 'snapshot') {
      const previous = this.threads.get(message.threadId);
      if (!ownsThread(message.data, message.threadId)) return false;
      if (
        previous?.cursor.serverEpoch === message.cursor.serverEpoch &&
        previous.cursor.seq > message.cursor.seq
      )
        return false;
      this.threads.set(message.threadId, { data: message.data, cursor: message.cursor });
      return true;
    }
    if (message.kind === 'projects') {
      if (
        this.projectsCursor?.serverEpoch === message.cursor.serverEpoch &&
        this.projectsCursor.seq >= message.cursor.seq
      )
        return false;
      this.projectsCursor = message.cursor;
      return true;
    }
    if (message.kind === 'threadSummary' && message.threadId) {
      const previous = this.summaryCursors.get(message.threadId);
      if (
        previous?.serverEpoch === message.cursor.serverEpoch &&
        previous.seq >= message.cursor.seq
      )
        return false;
      this.summaryCursors.set(message.threadId, message.cursor);
      return true;
    }
    if ((message.kind === 'thread' || message.kind === 'threadPatch') && message.threadId) {
      const previous = this.threads.get(message.threadId);
      // A delta/event never establishes a projection. The subscription must get a snapshot first.
      if (
        !previous ||
        previous.cursor.serverEpoch !== message.cursor.serverEpoch ||
        previous.cursor.seq >= message.cursor.seq
      )
        return false;
      if (
        message.previousThreadSeq !== undefined &&
        previous.cursor.seq < message.previousThreadSeq
      )
        throw new Error('Missing thread event');
      if (message.kind === 'thread' && !ownsThread(message.payload as ThreadView, message.threadId))
        throw new Error('Mismatched thread event');
      this.threads.set(message.threadId, {
        data:
          message.kind === 'threadPatch'
            ? applyThreadPatch(previous.data, message.payload as ThreadPatch)
            : (message.payload as ThreadView),
        cursor: message.cursor,
      });
      return true;
    }
    if (
      this.runtimeCursor?.serverEpoch === message.cursor.serverEpoch &&
      this.runtimeCursor.seq >= message.cursor.seq
    )
      return false;
    this.runtimeCursor = message.cursor;
    return true;
  }
}

export function reconnectDelay(attempt: number, random = Math.random) {
  return Math.min(30_000, 700 * 2 ** Math.min(attempt, 6)) * (0.75 + random() * 0.25);
}

interface Handlers {
  snapshot?: typeof api.threadSnapshot;
  connection: (state: ConnectionState) => void;
  thread: (thread: ThreadView) => void;
  summary: (thread: ThreadSummary, cursor: Cursor) => void;
  system: (system: SystemInfo) => void;
  projects?: (projects: Project[]) => void;
  operation: (operation: Operation) => void;
  error: (message: string) => void;
  readError?: (threadId: string, problem: unknown) => void;
  completion?: (completion: TurnCompletion) => void;
  attention?: (request: AttentionRequest) => void;
  refresh?: () => void;
}

function ownsThread(data: ThreadView, id: string) {
  return (
    data.id === id &&
    (!data.execution || data.execution.threadId === id) &&
    data.turns.every((turn) => turn.threadId === id)
  );
}

function isMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const m = value as Record<string, unknown>;
  if (m.type === 'error')
    return Boolean(m.error && typeof m.error === 'object' && 'message' in m.error);
  if (!m.cursor || typeof m.cursor !== 'object') return false;
  const cursor = m.cursor as Record<string, unknown>;
  if (
    typeof cursor.serverEpoch !== 'string' ||
    typeof cursor.seq !== 'number' ||
    !Number.isSafeInteger(cursor.seq) ||
    cursor.seq < 0
  )
    return false;
  if (m.type === 'resync') return typeof m.threadId === 'string';
  if (m.type === 'subscribed')
    return (
      typeof m.threadId === 'string' &&
      typeof m.threadSeq === 'number' &&
      Number.isSafeInteger(m.threadSeq) &&
      m.threadSeq >= 0 &&
      m.threadSeq <= cursor.seq
    );
  const payload = (m.type === 'snapshot' ? m.data : m.payload) as
    Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return false;
  if (m.type === 'event' && m.kind === 'threadPatch') {
    const patch = payload as unknown as ThreadPatch;
    return (
      typeof m.threadId === 'string' &&
      patch.thread?.id === m.threadId &&
      Array.isArray(patch.turns)
    );
  }
  if (m.type === 'event' && m.kind === 'projects')
    return (
      Array.isArray(payload) &&
      payload.every(
        (project: unknown) =>
          project !== null &&
          typeof project === 'object' &&
          'id' in project &&
          typeof project.id === 'string' &&
          'name' in project &&
          typeof project.name === 'string' &&
          'rootPath' in project &&
          typeof project.rootPath === 'string' &&
          'available' in project &&
          typeof project.available === 'boolean',
      )
    );
  if (m.type === 'snapshot' || m.kind === 'thread')
    return (
      typeof m.threadId === 'string' &&
      payload.id === m.threadId &&
      Array.isArray(payload.turns) &&
      Array.isArray(payload.actions)
    );
  if (m.type === 'event' && m.kind === 'threadSummary')
    return (
      typeof m.threadId === 'string' &&
      payload.id === m.threadId &&
      (payload.projectId === null || typeof payload.projectId === 'string') &&
      typeof payload.title === 'string' &&
      typeof payload.status === 'string' &&
      typeof payload.pendingActionCount === 'number'
    );
  if (m.type === 'event' && m.kind === 'turnCompletion')
    return (
      typeof m.threadId === 'string' &&
      payload.threadId === m.threadId &&
      typeof payload.turnId === 'string' &&
      (payload.projectId === null || typeof payload.projectId === 'string') &&
      typeof payload.title === 'string' &&
      ['completed', 'failed', 'interrupted'].includes(String(payload.status))
    );
  if (m.type === 'event' && m.kind === 'attentionRequest') {
    const target = payload.target as Record<string, unknown> | undefined;
    return (
      typeof m.threadId === 'string' &&
      payload.threadId === m.threadId &&
      (payload.projectId === null || typeof payload.projectId === 'string') &&
      typeof payload.title === 'string' &&
      ['answer', 'approval'].includes(String(payload.kind)) &&
      Boolean(
        target &&
        ['action', 'question'].includes(String(target.kind)) &&
        typeof target.id === 'string',
      )
    );
  }
  return m.type === 'event' && (m.kind === 'runtime' || m.kind === 'operation');
}

interface Watch {
  projectId: string | null;
  subscriptionId?: number;
  ready: boolean;
  minimum?: Cursor;
  read?: { controller: AbortController; promise: Promise<void> };
}

export class ThreadStream {
  readonly cache = new ProjectionCache();
  private readonly watches = new Map<string, Watch>();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = true;
  private selected?: string;
  private reconnectQueue?: Iterator<string>;
  private reconnecting?: string;
  private blocked = false;
  private nextSubscriptionId = 0;

  constructor(private readonly handlers: Handlers) {}
  start() {
    this.stopped = false;
    window.addEventListener('online', this.retry);
    window.addEventListener('offline', this.offline);
    window.addEventListener('focus', this.retry);
    window.addEventListener('pageshow', this.resume);
    if (typeof document !== 'undefined') {
      document.addEventListener('freeze', this.offline);
      document.addEventListener('resume', this.resume);
      document.addEventListener('visibilitychange', this.visible);
    }
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.retry);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('focus', this.retry);
    window.removeEventListener('pageshow', this.resume);
    if (typeof document !== 'undefined') {
      document.removeEventListener('freeze', this.offline);
      document.removeEventListener('resume', this.resume);
      document.removeEventListener('visibilitychange', this.visible);
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.resetWatches();
  }
  view(threadId: string) {
    if (this.watches.get(threadId)?.ready) return this.cache.get(threadId)?.data;
  }
  select(threadId?: string, projectId: string | null = null) {
    this.selected = threadId;
    if (!threadId) return;
    const current = this.watches.get(threadId);
    if (current) this.retryWatch(threadId, current);
    else {
      const watch: Watch = { projectId, ready: false };
      this.watches.set(threadId, watch);
      this.subscribe(threadId, watch);
    }
    this.retry();
  }
  observe(summary: ThreadSummary, cursor: Cursor) {
    const watch = this.watches.get(summary.id);
    if (!watch) return;
    const cached = this.cache.get(summary.id);
    if (
      cached &&
      Boolean(cached.data.archived) !== Boolean(summary.archived) &&
      (cached.cursor.serverEpoch !== cursor.serverEpoch || cached.cursor.seq < cursor.seq)
    ) {
      // A lifecycle summary can reveal a missing detail change. Keep the visit and
      // recover authoritative history before it can be reopened.
      watch.read?.controller.abort();
      watch.read = undefined;
      watch.ready = false;
      this.cache.invalidateDetail(summary.id);
      this.subscribe(summary.id, watch);
    } else this.retryWatch(summary.id, watch);
  }
  removeProject(projectId: string) {
    for (const [id, watch] of this.watches) if (watch.projectId === projectId) this.forget(id);
    this.cache.removeProject(projectId);
  }
  forget(threadId: string) {
    const watch = this.watches.get(threadId);
    if (!watch) return;
    watch.read?.controller.abort();
    this.watches.delete(threadId);
    this.cache.invalidateDetail(threadId);
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'unsubscribe', threadId }));
    this.finishReconnect(threadId);
  }
  private retryWatch(threadId: string, watch: Watch) {
    if (!watch.ready && watch.subscriptionId === undefined && !watch.read)
      this.subscribe(threadId, watch);
  }
  isWatching(threadId: string) {
    return this.watches.has(threadId);
  }
  refresh(threadId: string) {
    const watch = this.watches.get(threadId);
    if (watch && this.socket?.readyState === WebSocket.OPEN) {
      if (!watch.ready && watch.subscriptionId !== undefined) return watch.read?.promise;
      return this.readSnapshot(threadId, watch, this.socket, watch.minimum);
    }
    this.retry();
  }
  retry = () => {
    if (
      this.stopped ||
      this.blocked ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(this.timer);
    this.connect();
  };
  private resetWatches() {
    this.reconnectQueue = undefined;
    this.reconnecting = undefined;
    for (const watch of this.watches.values()) {
      watch.ready = false;
      watch.read?.controller.abort();
      watch.read = undefined;
      watch.subscriptionId = undefined;
      watch.minimum = undefined;
    }
  }
  private offline = () => {
    this.resetWatches();
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.handlers.connection('disconnected');
  };
  private resume = () => {
    if (this.stopped || this.blocked) return;
    this.retry();
    this.handlers.refresh?.();
  };
  private visible = () => {
    if (document.visibilityState === 'visible') this.resume();
  };
  private reconnectNext() {
    if (!this.reconnectQueue || this.reconnecting) return;
    // Replay one background visit at a time. Selection can still start its own recovery.
    for (let next = this.reconnectQueue.next(); !next.done; next = this.reconnectQueue.next()) {
      const id = next.value;
      const watch = this.watches.get(id);
      if (!watch || watch.ready || watch.subscriptionId !== undefined || watch.read) continue;
      this.reconnecting = id;
      this.subscribe(id, watch);
      return;
    }
    this.reconnectQueue = undefined;
  }
  private finishReconnect(threadId: string) {
    if (this.reconnecting !== threadId) return;
    this.reconnecting = undefined;
    this.reconnectNext();
  }
  private subscribe(threadId: string, watch: Watch) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const after = this.cache.get(threadId)?.cursor;
    watch.ready = false;
    watch.subscriptionId = ++this.nextSubscriptionId;
    this.socket.send(
      JSON.stringify({
        type: 'subscribe',
        threadId,
        incremental: true,
        subscriptionId: watch.subscriptionId,
        ...(after ? { after } : {}),
      }),
    );
  }
  private publish(threadId: string) {
    if (this.selected !== threadId) return;
    const data = this.cache.get(threadId)?.data;
    if (data) this.handlers.thread(data);
  }
  private readSnapshot(threadId: string, watch: Watch, socket: WebSocket, minimum?: Cursor) {
    if (watch.read) return watch.read.promise;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted && this.socket === socket && this.watches.get(threadId) === watch;
    const promise = (async () => {
      try {
        const snapshot = await (this.handlers.snapshot ?? api.threadSnapshot)(
          threadId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
        );
        if (!current()) return;
        const message = { type: 'snapshot' as const, threadId, ...snapshot };
        if (!isMessage(message) || !ownsThread(snapshot.data, threadId))
          throw new Error('Invalid thread snapshot');
        const previous = this.cache.get(threadId);
        const epoch = minimum?.serverEpoch ?? previous?.cursor.serverEpoch;
        if (epoch && snapshot.cursor.serverEpoch !== epoch) {
          socket.close();
          return;
        }
        if (minimum && snapshot.cursor.seq < minimum.seq)
          throw new Error('Thread snapshot precedes the recovery boundary');
        if (this.cache.apply(message) && watch.ready) this.publish(threadId);
        if (!watch.ready) this.subscribe(threadId, watch);
      } catch (problem) {
        if (!current()) return;
        if (problem instanceof HttpError && [401, 403, 404].includes(problem.status))
          this.forget(threadId);
        if (this.selected === threadId) this.handlers.readError?.(threadId, problem);
        if (problem instanceof HttpError && problem.authenticationRequired) {
          this.blocked = true;
          socket.close();
        } else this.finishReconnect(threadId);
      } finally {
        if (watch.read?.controller === controller) watch.read = undefined;
      }
    })();
    watch.read = { controller, promise };
    return promise;
  }
  private detail(value: ServerMessage, socket: WebSocket) {
    if (value.threadId === undefined) return;
    const id = value.threadId;
    const watch = this.watches.get(id);
    if (
      !watch ||
      value.subscriptionId === undefined ||
      watch.subscriptionId !== value.subscriptionId
    )
      return;
    if (value.type === 'error') {
      this.forget(id);
      if (id === this.selected)
        this.handlers.readError?.(id, new HttpError(value.status ?? 400, value.error));
      return;
    }
    const recover = () => {
      watch.ready = false;
      watch.read?.controller.abort();
      watch.read = undefined;
      watch.subscriptionId = undefined;
      watch.minimum = value.cursor;
      socket.send(JSON.stringify({ type: 'unsubscribe', threadId: id }));
      void this.readSnapshot(id, watch, socket, value.cursor);
    };
    if (value.type === 'resync') {
      recover();
      return;
    }
    if (value.type === 'subscribed') {
      if (!this.cache.advance(id, value.cursor, value.threadSeq)) {
        recover();
        return;
      }
      watch.ready = true;
      watch.minimum = undefined;
      this.publish(id);
      this.finishReconnect(id);
      return;
    }
    try {
      if (this.cache.apply(value) && watch.ready) this.publish(id);
    } catch {
      recover();
    }
  }
  private connect() {
    if (this.stopped || this.blocked) return;
    if (!navigator.onLine) {
      this.handlers.connection('disconnected');
      return;
    }
    this.handlers.connection(this.attempt === 0 ? 'connecting' : 'disconnected');
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?overview=1`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return socket.close();
      this.attempt = 0;
      this.reconnectQueue = this.watches.keys();
      const selected = this.selected ? this.watches.get(this.selected) : undefined;
      if (this.selected && selected) this.subscribe(this.selected, selected);
      this.reconnectNext();
      this.handlers.connection('connected');
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isMessage(value)) {
          this.handlers.error(t('errors:unrecognized_server_message_check_version_compatibility'));
          return;
        }
        if (
          value.type === 'snapshot' ||
          value.type === 'resync' ||
          value.type === 'subscribed' ||
          (value.type === 'event' && (value.kind === 'thread' || value.kind === 'threadPatch')) ||
          (value.type === 'error' && value.subscriptionId !== undefined)
        ) {
          this.detail(value, socket);
          return;
        }
        // Operation receipts retain their selected-detail scope. Background operations
        // still reconcile through the existing receipt lookup.
        if (
          value.type === 'event' &&
          value.kind === 'operation' &&
          (!this.selected || (value.threadId && value.threadId !== this.selected))
        )
          return;
        if (!this.cache.apply(value)) return;
        if (value.type === 'error') this.handlers.error(value.error.message);
        if (value.type !== 'event') return;
        if (value.kind === 'turnCompletion')
          this.handlers.completion?.(value.payload as TurnCompletion);
        if (value.kind === 'attentionRequest')
          this.handlers.attention?.(value.payload as AttentionRequest);
        if (value.kind === 'threadSummary')
          this.handlers.summary(value.payload as ThreadSummary, value.cursor);
        if (value.kind === 'runtime') this.handlers.system(value.payload as SystemInfo);
        if (value.kind === 'projects') this.handlers.projects?.(value.payload as Project[]);
        if (value.kind === 'operation') this.handlers.operation(value.payload as Operation);
      } catch {
        this.handlers.error(t('errors:could_not_parse_a_live_message_refresh_the'));
        socket.close();
      }
    };
    socket.onclose = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      this.resetWatches();
      if (this.blocked || [4001, 4401, 4403, 1008].includes(event.code)) {
        this.blocked = true;
        this.handlers.connection('authenticationRequired');
        return;
      }
      this.handlers.connection('disconnected');
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
    socket.onerror = () => {
      /* The close event schedules a single retry. */
    };
  }
}

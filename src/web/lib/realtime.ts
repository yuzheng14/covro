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
    if (message.type === 'resync') return true;
    // Live signals do not establish or advance any snapshot/replay cursor.
    if (message.type === 'event' && ['turnCompletion', 'attentionRequest'].includes(message.kind))
      return true;
    if (message.type === 'snapshot') {
      const previous = this.threads.get(message.threadId);
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
  completion?: (completion: TurnCompletion) => void;
  attention?: (request: AttentionRequest) => void;
  refresh?: () => void;
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
    !Number.isSafeInteger(cursor.seq)
  )
    return false;
  if (m.type === 'resync') return typeof m.threadId === 'string';
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
      typeof payload.id === 'string' &&
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

export class ThreadStream {
  readonly cache = new ProjectionCache();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = true;
  private selected?: string;
  private blocked = false;
  private syncRead?: AbortController;

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
    this.syncRead?.abort();
    this.syncRead = undefined;
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
    this.socket?.close();
    this.socket = undefined;
  }
  select(threadId?: string) {
    if (this.selected === threadId) return;
    this.syncRead?.abort();
    this.syncRead = undefined;
    this.selected = threadId;
    const cached = threadId ? this.cache.get(threadId) : undefined;
    if (cached) this.handlers.thread(cached.data);
    // Replace only the detail subscription. Project summaries continue on the same connection.
    if (this.socket?.readyState === WebSocket.OPEN) this.subscribe();
    else this.retry();
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
  private offline = () => {
    this.syncRead?.abort();
    this.syncRead = undefined;
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
  private subscribe() {
    const cached = this.selected ? this.cache.get(this.selected) : undefined;
    this.socket?.send(
      JSON.stringify(
        this.selected
          ? {
              type: 'subscribe',
              threadId: this.selected,
              incremental: true,
              ...(cached ? { after: cached.cursor } : {}),
            }
          : { type: 'unsubscribe' },
      ),
    );
  }
  private async synchronize(threadId: string, socket: WebSocket) {
    if (this.syncRead) return;
    const controller = new AbortController();
    this.syncRead = controller;
    // A resync can mean a large replacement was omitted. Later patches must not
    // advance past that gap; keep the displayed view until HTTP + replay recovers it.
    this.cache.invalidateDetail(threadId);
    try {
      const snapshot = await (this.handlers.snapshot ?? api.threadSnapshot)(
        threadId,
        controller.signal,
      );
      if (controller.signal.aborted || this.socket !== socket || this.selected !== threadId) return;
      const message = { type: 'snapshot' as const, threadId, ...snapshot };
      if (!isMessage(message) || snapshot.data.id !== threadId)
        throw new Error('Invalid thread snapshot');
      if (this.cache.apply(message)) this.handlers.thread(this.cache.get(threadId)!.data);
      // Replay everything after the HTTP boundary, including changes during the read.
      this.subscribe();
    } catch (problem) {
      if (controller.signal.aborted || this.socket !== socket || this.selected !== threadId) return;
      this.handlers.error(problem instanceof Error ? problem.message : String(problem));
      if (problem instanceof HttpError && problem.authenticationRequired) {
        this.blocked = true;
        this.handlers.connection('authenticationRequired');
      }
      socket.close();
    } finally {
      if (this.syncRead === controller) this.syncRead = undefined;
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
      this.handlers.connection('connected');
      if (this.selected) this.subscribe();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isMessage(value)) {
          this.handlers.error(t('errors:unrecognized_server_message_check_version_compatibility'));
          return;
        }
        if (value.type === 'resync') {
          if (value.threadId === this.selected) void this.synchronize(value.threadId, socket);
          return;
        }
        if (!this.cache.apply(value)) return;
        if (value.type === 'error') {
          this.handlers.error(value.error.message);
          return;
        }
        if (value.type === 'snapshot' && value.threadId === this.selected)
          this.handlers.thread(value.data);
        if (value.type === 'event') {
          if (value.kind === 'turnCompletion')
            this.handlers.completion?.(value.payload as TurnCompletion);
          if (value.kind === 'attentionRequest')
            this.handlers.attention?.(value.payload as AttentionRequest);
          if (value.kind === 'threadSummary')
            this.handlers.summary(value.payload as ThreadSummary, value.cursor);
          if (
            (value.kind === 'thread' || value.kind === 'threadPatch') &&
            value.threadId === this.selected
          )
            this.handlers.thread(this.cache.get(value.threadId!)!.data);
          if (value.kind === 'runtime') this.handlers.system(value.payload as SystemInfo);
          if (value.kind === 'projects') this.handlers.projects?.(value.payload as Project[]);
          if (value.kind === 'operation') this.handlers.operation(value.payload as Operation);
        }
      } catch {
        this.handlers.error(t('errors:could_not_parse_a_live_message_refresh_the'));
        if (this.selected) void this.synchronize(this.selected, socket);
      }
    };
    socket.onclose = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      this.syncRead?.abort();
      this.syncRead = undefined;
      if (this.blocked) {
        this.handlers.connection('authenticationRequired');
        return;
      }
      if (
        event.code === 4001 ||
        event.code === 4401 ||
        event.code === 4403 ||
        event.code === 1008
      ) {
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

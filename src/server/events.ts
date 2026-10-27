import { randomUUID } from 'node:crypto';
import type { ThreadPatch } from '../shared/thread-patch.js';
import { ThreadPatchBuilder, type StreamedItem } from './thread-patch.js';
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
} from '../shared/types.js';

type BusinessEvent = Extract<ServerMessage, { type: 'event' }>;
type Listener = (message: ServerMessage) => void;

/** Synchronous snapshot+subscription forms one JS event-loop boundary. */
export class EventHub {
  readonly serverEpoch = randomUUID();
  private seq = 0;
  private discardedThrough = 0;
  private bytes = 0;
  private readonly events: { event: BusinessEvent; bytes: number }[] = [];
  private readonly listeners = new Set<{ threadId: string; send: Listener }>();
  private readonly runtimeListeners = new Set<Listener>();
  private readonly overviewListeners = new Set<Listener>();
  private readonly threadPatches = new Map<string, ThreadPatchBuilder>();

  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

  cursor(): Cursor {
    return { serverEpoch: this.serverEpoch, seq: this.seq };
  }

  publish(
    kind: 'thread' | 'threadPatch' | 'runtime' | 'operation',
    payload: ThreadView | ThreadPatch | SystemInfo | Operation,
    threadId?: string,
  ): void {
    const event: BusinessEvent = {
      type: 'event',
      cursor: { serverEpoch: this.serverEpoch, seq: ++this.seq },
      kind,
      payload: structuredClone(payload),
      ...(threadId === undefined ? {} : { threadId }),
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.events.length > 0) {
      const removed = this.events.shift()!;
      this.bytes -= removed.bytes;
      this.discardedThrough = removed.event.cursor.seq;
    }
    for (const listener of this.listeners)
      if (!event.threadId || event.threadId === listener.threadId)
        this.deliver(listener.send, event);
    if (kind === 'runtime')
      for (const listener of this.runtimeListeners) this.deliver(listener, event);
  }

  subscribeRuntime(send: Listener): () => void {
    this.runtimeListeners.add(send);
    return () => {
      this.runtimeListeners.delete(send);
    };
  }

  publishThread(thread: ThreadView, streamed?: StreamedItem): void {
    let builder = this.threadPatches.get(thread.id);
    if (!builder) {
      builder = new ThreadPatchBuilder();
      this.threadPatches.set(thread.id, builder);
    }
    this.publish('threadPatch', builder.build(thread, streamed), thread.id);
  }

  /** Overview is recovered via HTTP; it never consumes the detailed replay buffer. */
  publishSummary(summary: ThreadSummary): void {
    const event: BusinessEvent = {
      type: 'event',
      kind: 'threadSummary',
      threadId: summary.id,
      cursor: this.cursor(),
      payload: structuredClone(summary),
    };
    for (const listener of this.overviewListeners) this.deliver(listener, event);
  }

  subscribeOverview(send: Listener): () => void {
    this.overviewListeners.add(send);
    return () => {
      this.overviewListeners.delete(send);
    };
  }

  /** Only connected overview clients receive this signal. It never enters the replay buffer. */
  publishCompletion(completion: TurnCompletion): void {
    const event: BusinessEvent = {
      type: 'event',
      kind: 'turnCompletion',
      threadId: completion.threadId,
      cursor: this.cursor(),
      payload: structuredClone(completion),
    };
    for (const listener of this.overviewListeners) this.deliver(listener, event);
  }

  publishAttention(request: AttentionRequest): void {
    const event: BusinessEvent = {
      type: 'event',
      kind: 'attentionRequest',
      threadId: request.threadId,
      cursor: this.cursor(),
      payload: structuredClone(request),
    };
    for (const listener of this.overviewListeners) this.deliver(listener, event);
  }

  /** Project snapshots have their own update boundary even without a thread event. */
  publishProjects(projects: Project[]): void {
    const event: BusinessEvent = {
      type: 'event',
      kind: 'projects',
      cursor: { serverEpoch: this.serverEpoch, seq: ++this.seq },
      payload: structuredClone(projects),
    };
    for (const listener of this.overviewListeners) this.deliver(listener, event);
  }

  subscribe(
    threadId: string,
    snapshot: () => ThreadView,
    after: Cursor | undefined,
    send: Listener,
    incremental = false,
  ): () => void {
    const replayable =
      after?.serverEpoch === this.serverEpoch &&
      after.seq >= this.discardedThrough &&
      after.seq <= this.seq;
    const queued: ServerMessage[] = [];
    let initializing = true;
    const listener = {
      threadId,
      send: (message: ServerMessage) => {
        if (initializing) queued.push(message);
        else send(message);
      },
    };
    this.listeners.add(listener);
    // No await may occur between reading the snapshot and registering the listener.
    let boundary = this.seq;
    if (replayable && after) {
      for (const { event } of [...this.events])
        if (
          event.cursor.seq > after.seq &&
          event.cursor.seq <= boundary &&
          (!event.threadId || event.threadId === threadId)
        )
          this.deliver(send, event);
    } else {
      boundary = this.seq;
      this.deliver(
        send,
        incremental
          ? { type: 'resync', cursor: this.cursor(), threadId }
          : {
              type: 'snapshot',
              cursor: this.cursor(),
              threadId,
              data: structuredClone(snapshot()),
            },
      );
    }
    initializing = false;
    for (const message of queued)
      if (message.type === 'event' && message.cursor.seq > boundary) this.deliver(send, message);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deliver(send: Listener, message: ServerMessage): void {
    // A closed or slow browser must never unwind the upstream event consumer.
    try {
      send(message);
    } catch {
      /* Transport closes or unsubscribes its own failed socket. */
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, ThreadView } from '../../src/shared/types';
import { toThreadSummary } from '../../src/shared/thread-summary';
import { ThreadStream } from '../../src/web/lib/realtime';

const thread = (id: string): ThreadView => ({
  id,
  projectId: id,
  cwd: `/${id}`,
  title: id,
  status: 'idle',
  source: 'appServer',
  managed: true,
  turns: [],
  actions: [],
});

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  send = vi.fn<(data: string) => void>();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let stream: ThreadStream | undefined;
afterEach(() => {
  stream?.stop();
  stream = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function start(snapshot?: ConstructorParameters<typeof ThreadStream>[0]['snapshot']) {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  const handlers = {
    snapshot,
    connection: vi.fn(),
    thread: vi.fn(),
    summary: vi.fn(),
    system: vi.fn(),
    operation: vi.fn(),
    error: vi.fn(),
    completion: vi.fn(),
    attention: vi.fn(),
    refresh: vi.fn(),
  };
  stream = new ThreadStream(handlers);
  stream.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  return { stream, socket, handlers };
}

describe('HTTP snapshot and incremental replay', () => {
  it('hydrates full history then asks for updates after the HTTP cursor', async () => {
    let finish!: (value: {
      data: ThreadView;
      cursor: { serverEpoch: string; seq: number };
    }) => void;
    const read = vi.fn(
      () =>
        new Promise<{ data: ThreadView; cursor: { serverEpoch: string; seq: number } }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const { stream, socket, handlers } = start(read);
    stream.select('a');
    socket.receive({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 1 } });
    socket.receive({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 2 } });
    expect(read).toHaveBeenCalledTimes(1);
    const data = thread('a');
    data.turns = [
      {
        id: 't',
        threadId: 'a',
        status: 'running',
        items: [{ id: 'i', type: 'agentMessage', text: '正文'.repeat(400) }],
      },
    ];
    finish({ data, cursor: { serverEpoch: 'epoch', seq: 3 } });
    await vi.waitFor(() => expect(handlers.thread).toHaveBeenCalledWith(data));
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({
      type: 'subscribe',
      incremental: true,
      threadId: 'a',
      after: { serverEpoch: 'epoch', seq: 3 },
    });
    const { turns: _turns, ...metadata } = data;
    const patch: ServerMessage = {
      type: 'event',
      kind: 'threadPatch',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 5 },
      payload: {
        thread: metadata,
        turns: [
          {
            turn: { id: 't', threadId: 'a', status: 'running' },
            items: [{ id: 'i', append: { field: 'text', offset: 800, text: '，实时末尾' } }],
          },
        ],
      },
    };
    socket.receive(patch);
    socket.receive(patch);
    expect(stream.cache.get('a')!.data.turns[0]!.items[0]!.text).toBe(
      '正文'.repeat(400) + '，实时末尾',
    );
    expect(handlers.thread).toHaveBeenCalledTimes(2);
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it('does not advance past a missing replacement while recovering its HTTP snapshot', async () => {
    let finish!: (value: {
      data: ThreadView;
      cursor: { serverEpoch: string; seq: number };
    }) => void;
    const { stream, socket, handlers } = start(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stream.select('a');
    socket.receive({
      type: 'snapshot',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 1 },
      data: thread('a'),
    });
    socket.receive({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 2 } });
    const later: ServerMessage = {
      type: 'event',
      kind: 'thread',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 5 },
      payload: { ...thread('a'), title: '最新标题' },
    };
    socket.receive(later);
    expect(stream.cache.get('a')).toBeUndefined();
    finish({ data: thread('a'), cursor: { serverEpoch: 'epoch', seq: 3 } });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(stream.cache.get('a')!.data.title).toBe('a');
    expect(JSON.parse(socket.send.mock.lastCall![0]).after.seq).toBe(3);
    expect(handlers.thread).toHaveBeenCalledTimes(2);
    socket.receive(later);
    expect(stream.cache.get('a')!.data.title).toBe('最新标题');
  });

  it('aborts a previous selection and ignores its late snapshot', async () => {
    let finish!: (value: {
      data: ThreadView;
      cursor: { serverEpoch: string; seq: number };
    }) => void;
    let signal: AbortSignal | undefined;
    const { stream, socket, handlers } = start((_id, input) => {
      signal = input;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    stream.select('a');
    socket.receive({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 1 } });
    stream.select('b');
    expect(signal!.aborted).toBe(true);
    finish({ data: thread('a'), cursor: { serverEpoch: 'epoch', seq: 3 } });
    await Promise.resolve();
    expect(handlers.thread).not.toHaveBeenCalled();
    expect(stream.cache.get('a')).toBeUndefined();
    expect(JSON.parse(socket.send.mock.lastCall![0]).threadId).toBe('b');
  });

  it('retries a failed HTTP synchronization through the reconnect path', async () => {
    const { socket, stream, handlers } = start(async () => {
      throw new Error('read failed');
    });
    stream.select('a');
    socket.receive({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 1 } });
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
    expect(handlers.error).toHaveBeenCalledWith('read failed');
    expect(stream.cache.get('a')).toBeUndefined();
    expect(handlers.connection).toHaveBeenLastCalledWith('disconnected');
  });
});

describe('workspace overview transport', () => {
  it('keeps completion signals independent of replay cursors and rejects malformed endings', () => {
    const { stream, socket, handlers } = start();
    const completion: ServerMessage = {
      type: 'event',
      kind: 'turnCompletion',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 2 },
      payload: { threadId: 'b', turnId: 'turn', projectId: 'p', title: 'result', status: 'failed' },
    };
    socket.receive(completion);
    expect(handlers.completion).toHaveBeenCalledWith(completion.payload);
    expect(stream.cache.get('b')).toBeUndefined();
    socket.receive({
      ...completion,
      payload: { ...completion.payload, status: 'running' },
    } as ServerMessage);
    expect(handlers.completion).toHaveBeenCalledTimes(1);
    expect(handlers.error).toHaveBeenCalledTimes(1);
  });

  it('validates attention signals independently of detail subscriptions and cursors', () => {
    const { stream, socket, handlers } = start();
    const event: ServerMessage = {
      type: 'event',
      kind: 'attentionRequest',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 0 },
      payload: {
        threadId: 'b',
        projectId: null,
        title: 'question',
        kind: 'answer',
        target: { kind: 'question', id: 'item' },
      },
    };
    socket.receive(event);
    socket.receive(event);
    expect(handlers.attention).toHaveBeenCalledTimes(2);
    expect(stream.cache.get('b')).toBeUndefined();
    socket.receive({
      ...event,
      payload: { ...event.payload, target: { kind: 'invalid', id: 1 } },
    } as unknown as ServerMessage);
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.attention).toHaveBeenCalledTimes(2);
  });

  it('closes the socket before freezing and refreshes snapshots when the page resumes', () => {
    const { stream, socket, handlers } = start();
    document.dispatchEvent(new Event('freeze'));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(handlers.connection).toHaveBeenLastCalledWith('disconnected');
    expect(FakeSocket.instances).toHaveLength(1);
    document.dispatchEvent(new Event('resume'));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(handlers.refresh).toHaveBeenCalledOnce();
    FakeSocket.instances[1]!.open();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handlers.refresh).toHaveBeenCalledTimes(2);
    stream.stop();
    document.dispatchEvent(new Event('resume'));
    expect(handlers.refresh).toHaveBeenCalledTimes(2);
  });
  it('switches detail subscriptions without reconnecting or turning an overview into a replay cursor', () => {
    const { stream, socket, handlers } = start();
    expect(socket.url).toBe('ws://localhost/ws?overview=1');
    stream.select('a');
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({
      type: 'subscribe',
      incremental: true,
      threadId: 'a',
    });
    socket.receive({
      type: 'snapshot',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 10 },
      data: thread('a'),
    });
    socket.receive({
      type: 'event',
      kind: 'threadSummary',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 11 },
      payload: toThreadSummary(thread('b')),
    });
    stream.select('b');
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({
      type: 'subscribe',
      incremental: true,
      threadId: 'b',
    });
    stream.select('a');
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({
      type: 'subscribe',
      incremental: true,
      threadId: 'a',
      after: { serverEpoch: 'epoch', seq: 10 },
    });
    stream.select(undefined);
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({ type: 'unsubscribe' });
    socket.receive({
      type: 'event',
      kind: 'threadSummary',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 12 },
      payload: toThreadSummary(thread('b')),
    });
    expect(handlers.summary).toHaveBeenCalledTimes(2);
    expect(handlers.connection.mock.calls.filter(([state]) => state === 'connected')).toHaveLength(
      1,
    );
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it('resubscribes after a real disconnect and rejects duplicate summaries independently of details', () => {
    vi.useFakeTimers();
    const { stream, socket, handlers } = start();
    stream.select('a');
    socket.receive({
      type: 'snapshot',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 1 },
      data: thread('a'),
    });
    const overview: ServerMessage = {
      type: 'event',
      kind: 'threadSummary',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 2 },
      payload: toThreadSummary(thread('a')),
    };
    socket.receive(overview);
    socket.receive(overview);
    expect(handlers.summary).toHaveBeenCalledTimes(1);
    socket.readyState = 3;
    socket.onclose?.({ code: 1006 });
    vi.runOnlyPendingTimers();
    const reconnected = FakeSocket.instances[1]!;
    reconnected.open();
    expect(JSON.parse(reconnected.send.mock.lastCall![0])).toEqual({
      type: 'subscribe',
      incremental: true,
      threadId: 'a',
      after: { serverEpoch: 'epoch', seq: 1 },
    });
    expect(handlers.connection.mock.calls.filter(([state]) => state === 'connected')).toHaveLength(
      2,
    );
    reconnected.receive({
      type: 'event',
      kind: 'thread',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 2 },
      payload: thread('a'),
    });
    expect(stream.cache.get('a')?.cursor.seq).toBe(2);
    expect(handlers.thread).toHaveBeenCalledTimes(2);
  });
});

it('accepts overview summaries and completion signals with no project association', () => {
  const { socket, handlers } = start();
  const general = { ...thread('general'), projectId: null };
  const summary = toThreadSummary(general);
  socket.receive({
    type: 'event',
    kind: 'threadSummary',
    threadId: general.id,
    cursor: { serverEpoch: 'epoch', seq: 1 },
    payload: summary,
  });
  expect(handlers.summary).toHaveBeenCalledWith(summary, { serverEpoch: 'epoch', seq: 1 });
  const completion = {
    threadId: general.id,
    turnId: 'turn',
    projectId: null,
    title: 'General conversation',
    status: 'completed' as const,
  };
  socket.receive({
    type: 'event',
    kind: 'turnCompletion',
    threadId: general.id,
    cursor: { serverEpoch: 'epoch', seq: 2 },
    payload: completion,
  });
  expect(handlers.completion).toHaveBeenCalledWith(completion);
});

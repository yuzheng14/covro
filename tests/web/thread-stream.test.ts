import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Cursor, type ServerMessage, type ThreadView } from '../../src/shared/types';
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
  subscriptions() {
    return this.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((entry) => entry.type === 'subscribe');
  }
  subscription(id: string) {
    return this.subscriptions().findLast((entry) => entry.threadId === id);
  }
  detail(
    message: ServerMessage,
    subscriptionId = this.subscription(message.threadId!).subscriptionId,
  ) {
    this.receive({ ...message, subscriptionId });
  }
  ready(threadId: string, seq: number, threadSeq = seq, serverEpoch = 'epoch') {
    this.detail({ type: 'subscribed', threadId, cursor: { serverEpoch, seq }, threadSeq });
  }
  snapshot(id: string, seq: number) {
    this.detail({
      type: 'snapshot',
      threadId: id,
      cursor: { serverEpoch: 'epoch', seq },
      data: thread(id),
    });
    this.ready(id, seq);
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
    readError: vi.fn(),
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
    socket.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 1 } });
    socket.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 2 } });
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
    await vi.waitFor(() => expect(socket.subscription('a').after?.seq).toBe(3));
    expect(handlers.thread).not.toHaveBeenCalled();
    socket.ready('a', 3);
    expect(handlers.thread).toHaveBeenCalledWith(data);
    expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
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
    socket.detail(patch);
    socket.detail(patch);
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
    socket.snapshot('a', 1);
    socket.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 2 } });
    const later: ServerMessage = {
      type: 'event',
      kind: 'thread',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 5 },
      payload: { ...thread('a'), title: '最新标题' },
    };
    socket.detail(later);
    expect(stream.view('a')).toBeUndefined();
    finish({ data: thread('a'), cursor: { serverEpoch: 'epoch', seq: 3 } });
    await vi.waitFor(() => expect(socket.subscription('a').after?.seq).toBe(3));
    expect(stream.cache.get('a')!.data.title).toBe('a');
    expect(JSON.parse(socket.send.mock.lastCall![0]).after.seq).toBe(3);
    expect(handlers.thread).toHaveBeenCalledTimes(1);
    socket.detail(later);
    expect(handlers.thread).toHaveBeenCalledTimes(1);
    socket.ready('a', 5);
    expect(stream.cache.get('a')!.data.title).toBe('最新标题');
  });

  it('rejects a stale refresh and recovers a missing detail event before publishing', async () => {
    let finish!: (value: { data: ThreadView; cursor: Cursor }) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        data: { ...thread('a'), title: 'Recovered' },
        cursor: { serverEpoch: 'epoch', seq: 8 },
      });
    const { stream, socket, handlers } = start(read);
    stream.select('a');
    socket.snapshot('a', 1);
    const refresh = stream.refresh('a');
    socket.detail({
      type: 'event',
      kind: 'thread',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 3 },
      previousThreadSeq: 1,
      payload: { ...thread('a'), title: 'Live' },
    });
    finish({ data: { ...thread('a'), title: 'Stale' }, cursor: { serverEpoch: 'epoch', seq: 2 } });
    await refresh;
    expect(stream.view('a')?.title).toBe('Live');

    socket.detail({
      type: 'event',
      kind: 'threadPatch',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 7 },
      previousThreadSeq: 6,
      payload: { thread: thread('a'), turns: [] },
    });
    expect(stream.view('a')).toBeUndefined();
    await vi.waitFor(() => expect(socket.subscription('a').after?.seq).toBe(8));
    socket.ready('a', 8);
    expect(handlers.thread.mock.calls.map(([view]) => view.title)).toEqual([
      'a',
      'Live',
      'Recovered',
    ]);
  });

  it('keeps previously opened sessions live after more than eight visits', () => {
    const { stream, socket, handlers } = start();
    stream.select('oldest');
    socket.snapshot('oldest', 1);
    const first = socket.subscription('oldest');
    for (let i = 0; i < 12; i++) stream.select(`visit-${i}`);
    socket.detail({
      type: 'event',
      kind: 'thread',
      threadId: 'oldest',
      cursor: { serverEpoch: 'epoch', seq: 2 },
      payload: { ...thread('oldest'), title: 'Still synchronized' },
    });
    expect(handlers.thread).toHaveBeenCalledTimes(1);
    stream.select('oldest');
    expect(socket.subscription('oldest')).toEqual(first);
    expect(socket.subscriptions()).toHaveLength(13);
    expect(stream.view('oldest')?.title).toBe('Still synchronized');
  });

  it('reconnects every visit with serial background replay and foreground priority', () => {
    const { stream, socket } = start();
    for (const id of ['a', 'b', 'c']) {
      stream.select(id);
      socket.snapshot(id, 1);
    }
    socket.close();
    stream.retry();
    const reopened = FakeSocket.instances.at(-1)!;
    reopened.open();
    expect(reopened.subscriptions().map((entry) => entry.threadId)).toEqual(['c', 'a']);
    reopened.ready('a', 1);
    expect(reopened.subscriptions().map((entry) => entry.threadId)).toEqual(['c', 'a', 'b']);
    reopened.ready('b', 1);
    reopened.ready('c', 1);
    expect(['a', 'b', 'c'].every((id) => stream.view(id))).toBe(true);
  });

  it('ignores overview-only sessions and aborts details when a project goes away', async () => {
    let finish!: (value: { data: ThreadView; cursor: Cursor }) => void;
    let signal: AbortSignal | undefined;
    const { stream, socket, handlers } = start((_id, input) => {
      signal = input;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const cursor = { serverEpoch: 'epoch', seq: 1 };
    stream.observe(toThreadSummary({ ...thread('unvisited'), status: 'running' }), cursor);
    expect(socket.subscriptions()).toHaveLength(0);
    stream.select('a', 'a');
    socket.detail({ type: 'resync', threadId: 'a', cursor });
    stream.select('b', 'b');
    expect(signal?.aborted).toBe(false);
    stream.removeProject('a');
    expect(signal?.aborted).toBe(true);
    finish({ data: thread('a'), cursor });
    await Promise.resolve();
    expect(handlers.thread).not.toHaveBeenCalled();
    expect(stream.cache.get('a')).toBeUndefined();
  });

  it('recovers a missing archive transition while keeping the visited session', () => {
    const { stream, socket } = start();
    stream.select('a');
    socket.snapshot('a', 1);
    stream.select('b');
    stream.observe(toThreadSummary({ ...thread('a'), archived: true }), {
      serverEpoch: 'epoch',
      seq: 2,
    });
    expect(stream.isWatching('a')).toBe(true);
    expect(stream.view('a')).toBeUndefined();
    expect(socket.subscription('a').after).toBeUndefined();
  });

  it('retries a failed detail read on revisit without disrupting the socket', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({
        data: thread('a'),
        cursor: { serverEpoch: 'epoch', seq: 3 },
      });
    const { socket, stream, handlers } = start(read);
    stream.select('a');
    socket.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 1 } });
    await vi.waitFor(() => expect(handlers.readError).toHaveBeenCalledWith('a', expect.any(Error)));
    stream.select('b');
    stream.select('a');
    socket.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'epoch', seq: 2 } });
    await vi.waitFor(() => expect(socket.subscription('a').after?.seq).toBe(3));
    socket.ready('a', 3);
    expect(handlers.thread).toHaveBeenCalledWith(thread('a'));
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('rejects late reads and retired generations after a gateway epoch change', async () => {
    let finish!: (value: { data: ThreadView; cursor: Cursor }) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        data: { ...thread('a'), title: 'new gateway' },
        cursor: { serverEpoch: 'new', seq: 2 },
      });
    const { stream, socket, handlers } = start(read);
    stream.select('a');
    socket.snapshot('a', 50);
    void stream.refresh('a');
    socket.close();
    stream.retry();
    const reopened = FakeSocket.instances.at(-1)!;
    reopened.open();
    const old = reopened.subscription('a').subscriptionId;
    reopened.detail({ type: 'resync', threadId: 'a', cursor: { serverEpoch: 'new', seq: 1 } });
    await vi.waitFor(() => expect(reopened.subscription('a').after?.seq).toBe(2));
    reopened.detail(
      {
        type: 'snapshot',
        threadId: 'a',
        data: thread('a'),
        cursor: { serverEpoch: 'epoch', seq: 100 },
      },
      old,
    );
    reopened.ready('a', 2, 2, 'new');
    finish({ data: thread('a'), cursor: { serverEpoch: 'epoch', seq: 100 } });
    await Promise.resolve();
    expect(handlers.thread).toHaveBeenCalledTimes(2);
    expect(stream.view('a')?.title).toBe('new gateway');
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
  it('retains background detail independently of overview and current selection', () => {
    const { stream, socket, handlers } = start();
    stream.select('b');
    socket.snapshot('b', 1);
    stream.select('a');
    socket.snapshot('a', 2);
    socket.receive({
      type: 'event',
      kind: 'threadSummary',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 3 },
      payload: toThreadSummary({ ...thread('b'), status: 'completed' }),
    });
    expect(stream.view('b')?.status).toBe('idle');
    socket.detail({
      type: 'event',
      kind: 'thread',
      threadId: 'b',
      cursor: { serverEpoch: 'epoch', seq: 4 },
      payload: { ...thread('b'), status: 'completed' },
    });
    expect(handlers.thread.mock.calls.map(([view]) => view.id)).toEqual(['b', 'a']);
    stream.select('b');
    expect(stream.view('b')?.status).toBe('completed');
    expect(socket.subscriptions()).toHaveLength(2);
    expect(handlers.summary).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
  it('resubscribes after a real disconnect and rejects duplicate summaries independently of details', () => {
    vi.useFakeTimers();
    const { stream, socket, handlers } = start();
    stream.select('a');
    socket.snapshot('a', 1);
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
    expect(JSON.parse(reconnected.send.mock.lastCall![0])).toMatchObject({
      type: 'subscribe',
      incremental: true,
      threadId: 'a',
      after: { serverEpoch: 'epoch', seq: 1 },
    });
    expect(handlers.connection.mock.calls.filter(([state]) => state === 'connected')).toHaveLength(
      2,
    );
    reconnected.detail({
      type: 'event',
      kind: 'thread',
      threadId: 'a',
      cursor: { serverEpoch: 'epoch', seq: 2 },
      payload: thread('a'),
    });
    expect(stream.view('a')).toBeUndefined();
    expect(handlers.thread).toHaveBeenCalledTimes(1);
    reconnected.ready('a', 2);
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

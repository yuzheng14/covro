import { describe, expect, it } from 'vitest';
import { ThreadPatchBuilder } from '../../src/server/thread-patch.js';
import { EventHub } from '../../src/server/events.js';
import { sendBounded, type SocketSink } from '../../src/server/websocket.js';
import { applyThreadPatch } from '../../src/shared/thread-patch.js';
import { ProjectionCache } from '../../src/web/lib/realtime.js';
import { threadView } from './domain-helpers.js';
import type { ServerMessage } from '../../src/shared/types.js';

function longThread() {
  const thread = threadView('long', '/project');
  thread.turns = [
    {
      id: 'old',
      threadId: thread.id,
      status: 'completed',
      items: Array.from({ length: 60 }, (_, i) => ({
        id: String(i),
        type: 'commandExecution',
        output: '完整工具输出'.repeat(7000) + '历史末尾仍然保留',
      })),
    },
    {
      id: 'live',
      threadId: thread.id,
      status: 'running',
      items: [{ id: 'reply', type: 'agentMessage', text: '开始' }],
    },
  ];
  return thread;
}

describe('lossless incremental conversation transport', () => {
  it('keeps multi-megabyte history intact while streaming only the changed text', () => {
    const thread = longThread();
    const builder = new ThreadPatchBuilder();
    builder.build(thread);
    const original = structuredClone(thread);
    const cache = new ProjectionCache();
    cache.apply({
      type: 'snapshot',
      threadId: thread.id,
      cursor: { serverEpoch: 's', seq: 1 },
      data: original,
    });
    for (let seq = 2; seq < 12; seq++) {
      thread.turns[1]!.items[0]!.text += '，继续';
      const payload = builder.build(thread, { turnId: 'live', itemId: 'reply' });
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1000);
      expect(payload.turns[0]!.items[0]!.append?.text).toBe('，继续');
      const event: ServerMessage = {
        type: 'event',
        kind: 'threadPatch',
        threadId: thread.id,
        cursor: { serverEpoch: 's', seq },
        payload,
      };
      expect(cache.apply(event)).toBe(true);
      expect(cache.apply(event)).toBe(false);
    }
    expect(cache.get(thread.id)!.data).toEqual(thread);
    expect(cache.get(thread.id)!.data.turns[0]).toBe(original.turns[0]);
    expect(original.turns[1]!.items[0]!.text).toBe('开始');
  });

  it('corrects completed output, removed fields, item order, and removed turns by ID', () => {
    const thread = longThread();
    const builder = new ThreadPatchBuilder();
    builder.build(thread);
    const original = structuredClone(thread);
    thread.turns[1]!.reconnect = { status: 'retrying', message: 'retry' };
    let current = applyThreadPatch(original, builder.build(thread));
    delete thread.turns[1]!.reconnect;
    thread.turns[1]!.items[0]!.text = '修正后的完整回复';
    thread.turns[1]!.items.unshift({ id: 'first', type: 'userMessage', text: '要求' });
    thread.turns[1]!.status = 'completed';
    current = applyThreadPatch(current, builder.build(thread));
    expect(current).toEqual(thread);
    thread.turns[1]!.items.pop();
    thread.turns.shift();
    expect(applyThreadPatch(current, builder.build(thread))).toEqual(thread);
  });

  it('falls back to HTTP resync for large replacements without clipping content', () => {
    const thread = longThread();
    const builder = new ThreadPatchBuilder();
    const payload = builder.build(thread);
    const sent: ServerMessage[] = [];
    const socket: SocketSink = {
      readyState: 1,
      bufferedAmount: 0,
      send: (text) => sent.push(JSON.parse(text) as ServerMessage),
      close: () => {
        throw new Error('healthy socket was closed');
      },
    };
    sendBounded(
      socket,
      {
        type: 'event',
        kind: 'threadPatch',
        threadId: thread.id,
        cursor: { serverEpoch: 's', seq: 2 },
        payload,
      },
      4096,
    );
    expect(sent).toEqual([
      { type: 'resync', threadId: thread.id, cursor: { serverEpoch: 's', seq: 2 } },
    ]);
    expect(thread.turns[0]!.items[0]!.output).toContain('历史末尾仍然保留');
  });

  it('requests HTTP recovery for expired epochs/cursors, and replays changes after its boundary', () => {
    const hub = new EventHub(4000);
    const thread = longThread();
    hub.publishThread(thread);
    const messages: ServerMessage[] = [];
    hub.subscribe(
      thread.id,
      () => {
        throw new Error('must not serialize a websocket snapshot');
      },
      undefined,
      (message) => messages.push(message),
      true,
    )();
    expect(messages[0]?.type).toBe('resync');
    const boundary = hub.cursor();
    const saved = structuredClone(thread);
    thread.turns[1]!.items[0]!.text += '，读取期间的新内容';
    hub.publishThread(thread, { turnId: 'live', itemId: 'reply' });
    const replay: ServerMessage[] = [];
    hub.subscribe(
      thread.id,
      () => thread,
      boundary,
      (message) => replay.push(message),
      true,
    )();
    const cache = new ProjectionCache();
    cache.apply({ type: 'snapshot', threadId: thread.id, cursor: boundary, data: saved });
    for (const message of replay) cache.apply(message);
    expect(cache.get(thread.id)!.data).toEqual(thread);
    const expired: ServerMessage[] = [];
    hub.subscribe(
      thread.id,
      () => thread,
      { serverEpoch: 'old', seq: 0 },
      (message) => expired.push(message),
      true,
    )();
    expect(expired[0]?.type).toBe('resync');
    hub.subscribe(
      thread.id,
      () => thread,
      { ...boundary, seq: 0 },
      (message) => expired.push(message),
      true,
    )();
    expect(expired[1]?.type).toBe('resync');
  });
});

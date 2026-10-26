import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import type { ServerNotification } from '../../src/codex/generated/ServerNotification.js';
import type { CodexEvent } from '../../src/codex/types.js';

const identity = { threadId: 'thread-1', turnId: 'turn-1' };

function fixture() {
  const adapter = new CodexAdapter({ binary: process.execPath });
  const events: CodexEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return {
    adapter,
    events,
    notify: (event: ServerNotification) => adapter['notification'](event),
  };
}

describe('Codex upstream reconnect notifications', () => {
  it('scopes retries and terminal errors to their turn without changing runtime availability', () => {
    const { adapter, events, notify } = fixture();
    const diagnostics = adapter.diagnostics();
    for (const willRetry of [true, false]) {
      notify({
        method: 'error',
        params: {
          ...identity,
          willRetry,
          error: {
            message: willRetry ? 'Reconnecting... 2/5' : 'Stream disconnected before completion',
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
            additionalDetails: null,
            misalignment: null,
          },
        },
      });
    }
    expect(events).toEqual([
      {
        type: 'turnError',
        ...identity,
        message: 'Reconnecting... 2/5',
        willRetry: true,
        errorCode: 'responseStreamDisconnected',
      },
      {
        type: 'turnError',
        ...identity,
        message: 'Stream disconnected before completion',
        willRetry: false,
        errorCode: 'responseStreamDisconnected',
      },
    ]);
    expect(adapter.diagnostics()).toEqual(diagnostics);
  });

  it('retains capacity classification and the original cause on native retries and history', () => {
    const { events, notify } = fixture();
    notify({
      method: 'error',
      params: {
        ...identity,
        willRetry: true,
        error: {
          message: 'Reconnecting... 1/5',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: 'Selected model is at capacity. Please try a different model.',
          misalignment: null,
        },
      },
    });
    expect(events[0]).toMatchObject({
      errorCode: 'responseStreamDisconnected',
      errorDetails: 'Selected model is at capacity. Please try a different model.',
    });
    notify({
      method: 'error',
      params: {
        ...identity,
        willRetry: false,
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'serverOverloaded',
          additionalDetails: null,
          misalignment: null,
        },
      },
    });
    expect(events[1]).toMatchObject({ errorCode: 'serverOverloaded', willRetry: false });
  });

  it.each([
    {
      method: 'item/agentMessage/delta',
      params: { ...identity, itemId: 'message', delta: '继续回答' },
    },
    {
      method: 'item/plan/delta',
      params: { ...identity, itemId: 'plan', delta: '继续计划' },
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { ...identity, itemId: 'reasoning', delta: '继续思考', summaryIndex: 0 },
    },
    {
      method: 'item/reasoning/textDelta',
      params: { ...identity, itemId: 'reasoning', delta: '继续思考', contentIndex: 0 },
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { ...identity, itemId: 'reasoning', summaryIndex: 1 },
    },
    {
      method: 'rawResponse/completed',
      params: { ...identity, responseId: 'response-1', usage: null, usageMetadata: null },
    },
    {
      method: 'item/started',
      params: {
        ...identity,
        item: { type: 'reasoning', id: 'reasoning', summary: [], content: [] },
        startedAtMs: 100,
      },
    },
    {
      method: 'item/completed',
      params: {
        ...identity,
        item: { type: 'plan', id: 'plan', text: '恢复后收到完整计划' },
        completedAtMs: 100,
      },
    },
  ] satisfies ServerNotification[])(
    'reports model progress for $method without losing the content event',
    (notification) => {
      const { events, notify } = fixture();
      notify(notification);
      expect(events[0]).toEqual({ type: 'turnProgress', ...identity });
      if ('delta' in notification.params)
        expect(events[1]).toMatchObject({
          type: 'delta',
          ...identity,
          delta: notification.params.delta,
        });
      else if (notification.method === 'item/started' || notification.method === 'item/completed')
        expect(events[1]).toMatchObject({
          type: 'item',
          ...identity,
          item: { id: notification.params.item.id },
        });
    },
  );

  it('does not claim recovery from background tool activity or thread metadata', () => {
    const { events, notify } = fixture();
    const notifications: ServerNotification[] = [
      {
        method: 'item/commandExecution/outputDelta',
        params: { ...identity, itemId: 'command', delta: 'still running' },
      },
      {
        method: 'item/fileChange/outputDelta',
        params: { ...identity, itemId: 'patch', delta: 'patch output' },
      },
      {
        method: 'item/completed',
        params: {
          ...identity,
          item: { type: 'fileChange', id: 'patch', changes: [], status: 'completed' },
          completedAtMs: 100,
        },
      },
      {
        method: 'item/started',
        params: {
          ...identity,
          item: { type: 'userMessage', id: 'steer', clientId: null, content: [] },
          startedAtMs: 100,
        },
      },
      { method: 'turn/diff/updated', params: { ...identity, diff: '+updated' } },
      {
        method: 'thread/status/changed',
        params: { threadId: identity.threadId, status: { type: 'active', activeFlags: [] } },
      },
      {
        method: 'thread/name/updated',
        params: { threadId: identity.threadId, threadName: 'Renamed thread' },
      },
    ];
    notifications.forEach(notify);
    expect(events).toHaveLength(notifications.length);
    expect(
      events.some((event) => event.type === 'turnProgress' || event.type === 'turnError'),
    ).toBe(false);
  });
});

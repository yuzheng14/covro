import { describe, expect, it } from 'vitest';
import type { ThreadView, TurnView } from '../../src/shared/types';
import { capacityTurnViews } from '../../src/web/lib/capacity-turns';

const root: TurnView = {
  id: 'root',
  threadId: 'thread',
  status: 'failed',
  error: 'capacity',
  errorCode: 'serverOverloaded',
  items: [{ id: 'prompt', type: 'userMessage', text: 'do the task', images: ['original-image'] }],
};
const retry: TurnView = {
  id: 'retry',
  retryOf: 'root',
  threadId: 'thread',
  status: 'failed',
  error: 'capacity',
  errorCode: 'serverOverloaded',
  items: [],
};
const thread = (turns: TurnView[], extra: Partial<ThreadView> = {}): ThreadView => ({
  id: 'thread',
  projectId: 'project',
  cwd: '/tmp',
  source: 'appServer',
  title: 'task',
  status: 'failed',
  managed: true,
  actions: [],
  turns,
  ...extra,
});

describe('capacity turn presentation', () => {
  it('keeps one prompt and the final native identity while preserving the source turns', () => {
    const success: TurnView = {
      ...retry,
      id: 'success',
      status: 'completed',
      error: undefined,
      items: [{ id: 'answer', type: 'agentMessage', text: 'done' }],
    };
    const original = thread([root, retry, success]);
    const result = capacityTurnViews(original);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'success',
      status: 'completed',
      items: [root.items[0], success.items[0]],
    });
    expect(original.turns).toHaveLength(3);
    expect(original.turns[0]?.error).toBe('capacity');
  });
  it('shows the logical task as running while waiting without exposing a second failure banner', () => {
    const result = capacityTurnViews(
      thread([root, retry], {
        capacityRetry: {
          rootTurnId: 'root',
          turnId: 'retry',
          status: 'waiting',
          attempt: 2,
          limit: 3,
          nextAttemptAt: 123,
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'retry', status: 'running', error: undefined });
  });
  it('does not group partial tool execution or an intervening user request', () => {
    const partial = { ...root, items: [...root.items, { id: 'tool', type: 'commandExecution' }] };
    expect(capacityTurnViews(thread([partial, retry]))).toHaveLength(2);
    expect(
      capacityTurnViews(
        thread([
          root,
          {
            ...retry,
            id: 'other',
            retryOf: undefined,
            items: [{ id: 'new-user', type: 'userMessage', text: 'new task' }],
          },
          retry,
        ]),
      ),
    ).toHaveLength(3);
  });
  it('does not hide unrelated failures or group an unlinked empty turn', () => {
    const unrelated = {
      ...retry,
      retryOf: undefined,
      errorCode: 'badRequest',
      error: 'invalid request',
    };
    const result = capacityTurnViews(thread([root, unrelated]));
    expect(result).toHaveLength(2);
    expect(result[1]?.error).toBe('invalid request');
  });
});

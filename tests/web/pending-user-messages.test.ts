import { expect, it } from 'vitest';
import type { PendingUserMessage, ThreadView } from '../../src/shared/types';
import { submittedUserMessage } from '../../src/shared/user-message';
import {
  submittedConversation,
  withPendingMessages,
} from '../../src/web/lib/pending-user-messages';
import { cachedReadingView } from '../../src/web/lib/history-cache';
const thread: ThreadView = {
  id: 'thread',
  projectId: 'project',
  cwd: '/project',
  title: '',
  source: 'appServer',
  managed: true,
  status: 'running',
  actions: [],
  turns: [
    {
      id: 'turn',
      threadId: 'thread',
      status: 'running',
      items: [{ id: 'compact', type: 'contextCompaction', status: 'inProgress' }],
    },
  ],
};
const pending = (id = 'submission'): PendingUserMessage => ({
  id,
  threadId: 'thread',
  kind: 'start',
  item: submittedUserMessage(id, { text: 'same text', images: ['image'] }),
  status: 'submitting',
  createdAt: 1,
});

it('shows an unbound submission without fabricating a native turn, then binds before compaction', () => {
  const message = pending();
  const before = submittedConversation(withPendingMessages(thread, [message]));
  expect(before.unbound).toMatchObject([
    { text: 'same text', images: ['image'], submissionStatus: 'submitting' },
  ]);
  expect(before.turns).toHaveLength(1);
  const bound = submittedConversation(
    withPendingMessages(thread, [{ ...message, turnId: 'turn' }]),
  );
  expect(bound.unbound).toHaveLength(0);
  expect(bound.turns[0]!.items.map((item) => item.type)).toEqual([
    'userMessage',
    'contextCompaction',
  ]);
  expect(thread.turns[0]!.items).toHaveLength(1);
});
it('prefers durable server state, keeps different identical submissions, and excludes other threads', () => {
  const message = pending();
  const view = withPendingMessages(
    { ...thread, pendingMessages: [{ ...message, turnId: 'turn', status: 'submitted' }] },
    [message, pending('second'), { ...pending('foreign'), threadId: 'other' }],
  );
  expect(view.pendingMessages).toHaveLength(2);
  expect(view.pendingMessages?.[1]).toMatchObject({
    id: 'submission',
    status: 'submitted',
    turnId: 'turn',
  });
});
it('replaces only the matching native message and appends steers after earlier content', () => {
  const message = pending();
  const confirmed = {
    ...thread,
    turns: [
      {
        ...thread.turns[0]!,
        items: [{ id: 'native', type: 'userMessage', clientId: message.id, text: 'same text' }],
      },
    ],
  };
  const view = withPendingMessages(confirmed, [
    message,
    { ...pending('steer'), kind: 'steer', turnId: 'turn' },
  ]);
  expect(view.pendingMessages?.map((message) => message.id)).toEqual(['steer']);
  expect(submittedConversation(view).turns[0]!.items.map((item) => item.clientId)).toEqual([
    'submission',
    'steer',
  ]);
});
it('preserves delivery uncertainty in cached reading views', () => {
  const view = cachedReadingView({
    ...thread,
    pendingMessages: [pending(), { ...pending('failure'), status: 'failed' }],
  });
  expect(view.pendingMessages?.map((message) => message.status)).toEqual(['unknown', 'failed']);
});

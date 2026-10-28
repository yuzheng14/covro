import { describe, expect, it } from 'vitest';
import type { Operation } from '../../src/shared/types';
import { ConversationDrafts } from '../../src/web/lib/conversation-drafts';

const receipt = (id: string, status: Operation['status'], result?: unknown): Operation => ({
  clientOperationId: id,
  kind: 'thread.create',
  target: 'project',
  status,
  createdAt: 1,
  updatedAt: 2,
  result,
});
describe('conversation draft ownership', () => {
  it('moves the original draft to the created thread exactly once and gives the project a fresh draft', () => {
    const drafts = new ConversationDrafts();
    const key = drafts.key('project');
    const settings = { model: 'chosen', reasoningEffort: 'high' };
    drafts.track('create', { kind: 'create', projectId: 'project', key, settings });
    expect(drafts.apply(receipt('create', 'dispatching'))).toBeUndefined();
    expect(drafts.key('project')).toBe(key);
    expect(drafts.apply(receipt('create', 'acknowledged', { threadId: 'thread' }))).toEqual({
      created: { id: 'thread', settings },
    });
    expect(drafts.key('project', 'thread')).toBe(key);
    const next = drafts.key('project');
    expect(next).not.toBe(key);
    expect(drafts.key('other')).toBe('project:other');
    expect(drafts.apply(receipt('create', 'acknowledged', { threadId: 'thread' }))).toBeUndefined();
    expect(drafts.key('project')).toBe(next);
  });
  it('keeps the same draft after failure, and moves it when a new attempt succeeds', () => {
    const drafts = new ConversationDrafts();
    const key = drafts.key('project');
    drafts.track('failed', { kind: 'create', projectId: 'project', key, settings: {} });
    drafts.apply(receipt('failed', 'failed'));
    expect(drafts.key('project')).toBe(key);
    drafts.track('retry', { kind: 'create', projectId: 'project', key, settings: {} });
    drafts.apply(receipt('retry', 'acknowledged', { threadId: 'retry-thread' }));
    expect(drafts.key('project', 'retry-thread')).toBe(key);
  });
  it('retains uncertain submissions until their own receipt arrives and acknowledges a prompt only once', () => {
    const drafts = new ConversationDrafts();
    drafts.track('send', { kind: 'send', key: 'draft', text: 'private prompt', images: ['image'] });
    expect(drafts.apply(receipt('send', 'unknown'))).toBeUndefined();
    expect(drafts.apply(receipt('unrelated', 'acknowledged'))).toBeUndefined();
    expect(drafts.apply(receipt('send', 'acknowledged'))).toEqual({
      sent: { kind: 'send', key: 'draft', text: 'private prompt', images: ['image'] },
    });
    expect(drafts.apply(receipt('send', 'acknowledged'))).toBeUndefined();
  });
});

it('rotates the reserved creation identity after a definite HTTP failure but keeps unknown intent stable', () => {
  const drafts = new ConversationDrafts();
  const key = drafts.key('project');
  const creationId = drafts.creationId(key);
  drafts.track(creationId, { kind: 'create', key, projectId: 'project', settings: {}, creationId });
  expect(drafts.creationId(key)).toBe(creationId);
  drafts.discard(creationId);
  expect(drafts.creationId(key)).not.toBe(creationId);
});

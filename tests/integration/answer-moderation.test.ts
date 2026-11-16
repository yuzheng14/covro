import { expect, it } from 'vitest';
import { mapItem } from '../../src/codex/mapping';
import { Projection } from '../../src/server/projection';
import { compactThreadForTransport } from '../../src/server/snapshot';
import type { ThreadView } from '../../src/shared/types';

// Exercise the JSON boundary, including old payloads that predate generated required fields.
const fromWire = (value: unknown) => mapItem(JSON.parse(JSON.stringify(value)));

const wire = {
  type: 'agentMessage' as const,
  id: 'answer',
  text: 'Final answer',
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
};
it('preserves answer-scoped moderation, false values and unknown display actions while stripping unrecognized fields', () => {
  const item = {
    ...wire,
    moderation: {
      moderated: false,
      display: { action: 'future-action', checkTrustedContacts: false, privateField: 'secret' },
      privateField: 'secret',
    },
  };
  const mapped = fromWire(item);
  expect(mapped.moderation).toEqual({
    moderated: false,
    display: {
      action: 'future-action',
      blockType: null,
      cyberTrustedAccess: null,
      checkTrustedContacts: false,
    },
  });
  expect(JSON.stringify(mapped)).not.toContain('secret');
  expect(fromWire({ ...wire, moderation: null }).moderation).toBeNull();
  expect(fromWire(JSON.parse(JSON.stringify(wire)))).not.toHaveProperty('moderation');
});

it('updates only the targeted answer across streaming, snapshots, cold projection and explicit clearing', () => {
  const source: ThreadView = {
    id: 'thread',
    projectId: 'project',
    cwd: '/tmp',
    title: 'Task',
    source: 'appServer',
    managed: true,
    status: 'running',
    actions: [],
    turns: [{ id: 'turn', threadId: 'thread', status: 'running', items: [] }],
  };
  const projection = new Projection();
  projection.thread(source);
  projection.delta('thread', 'turn', 'answer', 'text', 'Streaming answer');
  projection.item(
    'thread',
    'turn',
    fromWire({ ...wire, text: 'x'.repeat(20000), moderation: { moderated: true, display: null } }),
  );
  projection.item('thread', 'turn', fromWire({ ...wire, id: 'other-answer', moderation: null }));
  const snapshot = compactThreadForTransport(projection.get('thread')!, 4000);
  expect(snapshot.turns[0]?.items.find((item) => item.id === 'answer')?.moderation).toEqual({
    moderated: true,
    display: null,
  });
  expect(
    snapshot.turns[0]?.items.find((item) => item.id === 'other-answer')?.moderation,
  ).toBeNull();
  const restored = new Projection();
  restored.thread(JSON.parse(JSON.stringify(snapshot)));
  expect(restored.get('thread')?.turns[0]?.items[0]?.moderation).toEqual({
    moderated: true,
    display: null,
  });
  restored.item('thread', 'turn', fromWire({ ...wire, moderation: null }));
  expect(restored.get('thread')?.turns[0]?.items[0]?.moderation).toBeNull();
  expect(restored.get('thread')?.status).toBe('running');
  expect(restored.get('thread')?.actions).toEqual([]);
});

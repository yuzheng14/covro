import { expect, it } from 'vitest';
import { HistoryWindow, mergeHistoryTurns } from '../../src/web/lib/thread-history';
import type { ThreadView, TurnView } from '../../src/shared/types';
const turn = (id: string, text = id): TurnView => ({
  id,
  threadId: 'one',
  status: 'completed',
  items: [{ id: `item-${id}`, type: 'agentMessage', text }],
});
const page = (ids: string[], cursor: string | null): ThreadView => ({
  id: 'one',
  projectId: 'project',
  cwd: '/',
  source: 'test',
  title: 'test',
  managed: true,
  status: 'idle',
  actions: [],
  turns: ids.map((id) => turn(id)),
  history: { olderCursor: cursor },
});
it('deduplicates boundary turns and corrects status and items from the authoritative turn', () => {
  const corrected = { ...turn('b', 'corrected'), status: 'failed' as const };
  expect(mergeHistoryTurns([turn('a'), turn('b')], [corrected, turn('c')])).toEqual([
    turn('a'),
    corrected,
    turn('c'),
  ]);
});
it('keeps live metadata and new turns when a delayed historical page arrives', () => {
  const window = new HistoryWindow(page(['c', 'd'], 'older'));
  window.update({ ...page(['c', 'd', 'e'], 'older'), status: 'running' });
  window.append('older', page(['a', 'b', 'c'], null));
  expect(window.view.turns.map((turn) => turn.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(window.view.status).toBe('running');
  expect(window.cursor).toBeNull();
  window.append('older', page(['a'], null));
  expect(window.chunks).toHaveLength(1);
});
it('rejects foreign pages and nonadvancing cursors and resets when history becomes complete', () => {
  const window = new HistoryWindow(page(['c'], 'older'));
  expect(() => window.append('older', { ...page(['b'], null), id: 'other' })).toThrow();
  expect(() => window.append('older', page(['b'], 'older'))).toThrow();
  window.append('older', page(['b'], null));
  window.update(page(['c'], null));
  expect(window.view.turns.map((turn) => turn.id)).toEqual(['c']);
});
it('locates turn and item snapshots in their newest authoritative history page', () => {
  const window = new HistoryWindow(page(['d', 'e'], 'recent'));
  window.append('recent', page(['b', 'c', 'd'], 'older'));
  window.append('older', page(['a', 'b'], null));
  expect(window.getHistoryCursor('d')).toBeUndefined();
  expect(window.getHistoryCursor('item-d')).toBeUndefined();
  expect(window.getHistoryCursor('b')).toBe('recent');
  expect(window.getHistoryCursor('item-b')).toBe('recent');
  expect(window.getHistoryCursor('a')).toBe('older');
  expect(window.getHistoryCursor('item-a')).toBe('older');
  expect(window.getHistoryCursor('missing')).toBeUndefined();
});

it('preserves loaded history as turns leave the live page', () => {
  const window = new HistoryWindow({ ...page(['c', 'd'], 'before-c'), historyMode: 'paginated' });
  window.append('before-c', page(['a', 'b'], null));
  window.update({ ...page(['d', 'e'], 'before-d'), historyMode: 'paginated' });
  window.update({ ...page(['e', 'f'], 'before-e'), historyMode: 'paginated' });
  expect(window.view.turns.map((turn) => turn.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  expect(window.cursor).toBeNull();
});

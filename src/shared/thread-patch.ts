import type { ItemView, ThreadView, TurnView } from './types.js';

export interface ItemPatch {
  id: string;
  value?: ItemView;
  append?: { field: 'text' | 'output'; offset: number; text: string };
}

export interface ThreadPatch {
  thread: Omit<ThreadView, 'turns'>;
  turns: { turn: Omit<TurnView, 'items'>; items: ItemPatch[]; itemIds?: string[] }[];
  turnIds?: string[];
}

/** Absolute offsets make a streamed replacement safe after an HTTP snapshot or replay. */
export function applyThreadPatch(current: ThreadView, patch: ThreadPatch): ThreadView {
  const turns = new Map(current.turns.map((turn) => [turn.id, turn]));
  for (const update of patch.turns) {
    const previous = turns.get(update.turn.id);
    const items = new Map(previous?.items.map((item) => [item.id, item]));
    for (const change of update.items) {
      if (change.value) items.set(change.id, change.value);
      else if (change.append) {
        const item = items.get(change.id);
        const { field, offset, text } = change.append;
        if (
          !item ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          (item[field]?.length ?? 0) < offset
        )
          throw new Error('Missing streamed content; reload the thread snapshot');
        items.set(change.id, { ...item, [field]: (item[field] ?? '').slice(0, offset) + text });
      }
    }
    const ids = update.itemIds ?? [...items.keys()];
    turns.set(update.turn.id, {
      ...update.turn,
      items: ids.map((id) => {
        const item = items.get(id);
        if (!item) throw new Error('Missing item; reload the thread snapshot');
        return item;
      }),
    });
  }
  return {
    ...patch.thread,
    turns: (patch.turnIds ?? [...turns.keys()]).map((id) => {
      const turn = turns.get(id);
      if (!turn) throw new Error('Missing turn; reload the thread snapshot');
      return turn;
    }),
  };
}

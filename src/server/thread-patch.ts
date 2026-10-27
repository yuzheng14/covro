import type { ItemView, ThreadView } from '../shared/types.js';
import { isDeepStrictEqual } from 'node:util';
import type { ItemPatch, ThreadPatch } from '../shared/thread-patch.js';

export interface StreamedItem {
  turnId: string;
  itemId: string;
}

interface ItemState {
  value: ItemView;
}
interface TurnState {
  encoded: string;
  items: Map<string, ItemState>;
}

function itemPatch(previous: ItemView | undefined, item: ItemView): ItemPatch {
  if (previous) {
    for (const field of ['text', 'output'] as const) {
      const before = previous[field] ?? '';
      const after = item[field];
      if (
        after !== undefined &&
        after.startsWith(before) &&
        isDeepStrictEqual({ ...previous, [field]: undefined }, { ...item, [field]: undefined })
      )
        return {
          id: item.id,
          append: { field, offset: before.length, text: after.slice(before.length) },
        };
    }
  }
  return { id: item.id, value: structuredClone(item) };
}

/** Remember only one baseline. Streamed updates never traverse or serialize old item bodies. */
export class ThreadPatchBuilder {
  private readonly turns = new Map<string, TurnState>();
  build(view: ThreadView, streamed?: StreamedItem): ThreadPatch {
    const { turns, ...thread } = view;
    const patch: ThreadPatch = { thread, turns: [] };
    const turnIds = turns.map((turn) => turn.id);
    if (!streamed && JSON.stringify(turnIds) !== JSON.stringify([...this.turns.keys()]))
      patch.turnIds = turnIds;
    for (const turn of turns) {
      if (streamed && turn.id !== streamed.turnId) continue;
      const { items, ...metadata } = turn;
      const encoded = JSON.stringify(metadata);
      const previous = this.turns.get(turn.id);
      const state = previous ?? { encoded: '', items: new Map<string, ItemState>() };
      const update: ThreadPatch['turns'][number] = { turn: metadata, items: [] };
      for (const item of items) {
        if (streamed && item.id !== streamed.itemId) continue;
        const old = state.items.get(item.id);
        if (old && isDeepStrictEqual(old.value, item)) continue;
        update.items.push(itemPatch(old?.value, item));
        state.items.set(item.id, { value: structuredClone(item) });
      }
      const itemIds = items.map((item) => item.id);
      if (!streamed && JSON.stringify(itemIds) !== JSON.stringify([...state.items.keys()]))
        update.itemIds = itemIds;
      if (!previous || update.items.length || encoded !== state.encoded || update.itemIds)
        patch.turns.push(update);
      state.encoded = encoded;
      if (!streamed) state.items = new Map(itemIds.map((id) => [id, state.items.get(id)!]));
      this.turns.set(turn.id, state);
    }
    if (!streamed) {
      const ordered = turnIds.map((id) => [id, this.turns.get(id)!] as const);
      this.turns.clear();
      for (const [id, state] of ordered) this.turns.set(id, state);
    }
    return patch;
  }
}

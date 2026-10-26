import { scopeKey } from '../../shared/workspace-scope';
import type { ThreadView } from '../../shared/types';
import { DeviceCache } from './device-cache';
export { HISTORY_CACHE_LIMIT, HISTORY_CACHE_TTL } from './device-cache';

/** Cached execution state must never be mistaken for current control state. */
export function cachedReadingView(thread: ThreadView): ThreadView {
  return {
    ...thread,
    managed: false,
    status: 'unknown',
    actions: [],
    execution: undefined,
    resumeError: undefined,
    runtimeSettings: undefined,
    capacityRetry: undefined,
    turns: thread.turns.map((turn) => ({
      ...turn,
      status: ['running', 'waitingApproval', 'waitingInput'].includes(turn.status)
        ? 'unknown'
        : turn.status,
      reconnect: undefined,
      items: turn.items.map((item) => ({
        ...item,
        status: ['running', 'inProgress'].includes(item.status ?? '') ? 'unknown' : item.status,
      })),
    })),
  };
}

const storage = new DeviceCache();
const keyFor = (scope: string, project: string, thread: string, cursor = 'latest') =>
  JSON.stringify([scope, project, thread, cursor]);

export class HistoryCache {
  constructor(readonly scope: string) {}
  async read(project: string, thread: string, cursor?: string): Promise<ThreadView | undefined> {
    const page = await storage.read<ThreadView>(keyFor(this.scope, project, thread, cursor));
    if (
      !page ||
      page.id !== thread ||
      scopeKey(page.projectId) !== project ||
      !Array.isArray(page.turns)
    )
      return;
    try {
      return cachedReadingView(page);
    } catch {
      return;
    }
  }
  write(page: ThreadView, cursor?: string) {
    return storage.write(
      keyFor(this.scope, scopeKey(page.projectId), page.id, cursor),
      cachedReadingView(page),
    );
  }
  remove(project: string, thread: string) {
    return storage.remove(
      ([scope, projectId, threadId]) =>
        scope === this.scope && projectId === project && threadId === thread,
    );
  }
}

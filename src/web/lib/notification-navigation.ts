import type { AttentionTarget } from '../../shared/types';

export interface NotificationDestination {
  threadId: string;
  projectId: string;
  target?: AttentionTarget;
}

const fragment = '#notification=';
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function notificationURL(destination?: NotificationDestination): string {
  return destination ? `/${fragment}${encodeURIComponent(JSON.stringify(destination))}` : '/';
}

/** Notification navigation contains identifiers only; never trust arbitrary URLs or payloads. */
export function parseNotificationURL(value: unknown): NotificationDestination | undefined {
  if (typeof value !== 'string' || value.length > 32_768) return;
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.pathname !== '/' ||
      !url.hash.startsWith(fragment)
    )
      return;
    const data = JSON.parse(decodeURIComponent(url.hash.slice(fragment.length)));
    if (!data || !identifier(data.threadId) || !identifier(data.projectId)) return;
    if (
      data.target !== undefined &&
      (!data.target ||
        !['action', 'question'].includes(data.target.kind) ||
        !identifier(data.target.id))
    )
      return;
    return {
      threadId: data.threadId,
      projectId: data.projectId,
      ...(data.target && { target: { kind: data.target.kind, id: data.target.id } }),
    };
  } catch {
    return;
  }
}

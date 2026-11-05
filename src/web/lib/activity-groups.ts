import type { ItemView } from '../../shared/types';

export type ConversationItemGroup =
  | { kind: 'message'; key: string; item: ItemView }
  | { kind: 'activity'; key: string; items: ItemView[] };

/** Call once per turn: messages and turn boundaries must never disappear into a disclosure. */
export function groupConversationItems(items: readonly ItemView[]): ConversationItemGroup[] {
  const groups: ConversationItemGroup[] = [];
  for (const item of items) {
    if (
      item.type === 'userMessage' ||
      item.type === 'agentMessage' ||
      item.type === 'exitedReviewMode' ||
      item.type === 'contextCompaction'
    ) {
      groups.push({
        kind: 'message',
        key: `message:${item.type === 'userMessage' ? (item.clientId ?? item.id) : item.id}`,
        item,
      });
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.kind === 'activity') previous.items.push(item);
    // Even a single activity keeps the same wrapper and key when streaming appends more items.
    else
      groups.push({
        kind: 'activity',
        key: `activity:${item.id}`,
        items: [item],
      });
  }
  return groups;
}

export interface ActivityGroupStatus {
  total: number;
  reviews: number;
  running: number;
  completed: number;
  failed: number;
  denied: number;
  timedOut: number;
  interrupted: number;
  unknown: number;
}

/** Count every exceptional result so a collapsed group still exposes problems and active work. */
export function summarizeActivities(items: readonly ItemView[]): ActivityGroupStatus {
  const result: ActivityGroupStatus = {
    total: items.length,
    reviews: 0,
    running: 0,
    completed: 0,
    failed: 0,
    denied: 0,
    timedOut: 0,
    interrupted: 0,
    unknown: 0,
  };
  for (const item of items) {
    const isReview = item.type === 'autoApprovalReview';
    if (isReview) result.reviews += 1;
    const status = isReview ? (item.autoReview?.status ?? 'unknown') : item.status;
    const details =
      item.details && typeof item.details === 'object' && !Array.isArray(item.details)
        ? (item.details as Record<string, unknown>)
        : undefined;
    // These tool results stay in ItemView.details after mapping, including an unsuccessful result
    // from a completed invocation. Keep that distinction visible even before opening the group.
    const reportedFailure =
      (item.type === 'mcpToolCall' && details?.error != null) ||
      (item.type === 'dynamicToolCall' && details?.success === false) ||
      (item.type === 'imageGeneration' && details?.failure != null);
    if (item.error || status === 'failed' || reportedFailure) result.failed += 1;
    else if (status === 'denied' || status === 'declined') result.denied += 1;
    else if (status === 'timedOut') result.timedOut += 1;
    else if (status === 'aborted' || status === 'interrupted') result.interrupted += 1;
    else if (status === 'inProgress' || status === 'running') result.running += 1;
    else if (status === 'approved' || status === 'completed') result.completed += 1;
    else if (status) result.unknown += 1;
  }
  return result;
}

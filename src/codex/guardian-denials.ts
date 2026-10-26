import type { GuardianDenial } from '../shared/guardian-denials.js';
import type { JsonValue } from './generated/serde_json/JsonValue.js';
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification.js';
import { mapAutoReview } from './auto-review.js';
import { AppError } from '../shared/errors.js';

// v2 uses camelCase; the retry RPC expects the core protocol's snake_case event.
// Convert keys only: command text, paths, argument values and IDs remain verbatim.
function coreKeys(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(coreKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        coreKeys(item),
      ]),
    );
  return value as JsonValue;
}
export class GuardianDenials {
  private readonly entries = new Map<
    string,
    Map<string, { view: GuardianDenial; event: JsonValue }>
  >();
  clear(): void {
    this.entries.clear();
    this.consumed.clear();
  }
  forget(threadId: string): void {
    this.entries.delete(threadId);
  }
  record(p: ItemGuardianApprovalReviewCompletedNotification): void {
    if (p.review.status !== 'denied') return;
    const entries = this.entries.get(p.threadId) ?? new Map();
    const action = coreKeys(p.action) as Record<string, JsonValue>;
    action.type = p.action.type.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if ('source' in p.action)
      action.source = p.action.source === 'unifiedExec' ? 'unified_exec' : p.action.source;
    const event: JsonValue = {
      id: p.reviewId,
      target_item_id: p.targetItemId,
      turn_id: p.turnId,
      started_at_ms: p.startedAtMs,
      completed_at_ms: p.completedAtMs,
      status: 'denied',
      risk_level: p.review.riskLevel,
      user_authorization: p.review.userAuthorization,
      rationale: p.review.rationale,
      decision_source: p.decisionSource,
      action,
    };
    // Consumed identities cannot be reintroduced by a duplicate notification.
    if (!entries.has(p.reviewId))
      entries.set(p.reviewId, {
        view: { id: p.reviewId, turnId: p.turnId, review: mapAutoReview(p) },
        event,
      });
    while (entries.size > 10) entries.delete(entries.keys().next().value!);
    this.entries.set(p.threadId, entries);
  }
  private readonly consumed = new Set<string>();
  list(threadId: string): GuardianDenial[] {
    return [...(this.entries.get(threadId)?.values() ?? [])]
      .filter((entry) => !this.consumed.has(`${threadId}:${entry.view.id}`))
      .map((entry) => entry.view)
      .reverse();
  }
  take(threadId: string, id: string): JsonValue {
    const key = `${threadId}:${id}`;
    const entry = this.entries.get(threadId)?.get(id);
    if (!entry || this.consumed.has(key))
      throw new AppError('DENIAL_EXPIRED', '拒绝记录已失效，请重新查看当前会话', 409);
    this.consumed.add(key);
    return entry.event;
  }
}

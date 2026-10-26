import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { AppDatabase } from './index.js';
import { executionMarkers, operations, threadLinks } from './schema.js';
import type { ApiError } from '../../shared/types.js';

export type OperationRow = typeof operations.$inferSelect;
export type ExecutionMarker = typeof executionMarkers.$inferSelect;
export type ThreadLink = typeof threadLinks.$inferSelect;

export class StoreConflict extends Error {
  constructor(
    public readonly code: 'OPERATION_CONFLICT' | 'THREAD_BUSY',
    message: string,
    public readonly threadId?: string,
  ) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Every transaction is synchronous; no process/network work occurs inside one. */
export class OperationStore {
  constructor(public readonly database: AppDatabase) {}

  accept(
    clientOperationId: string,
    kind: string,
    target: string,
    request: unknown,
  ): { operation: OperationRow; inserted: boolean } {
    const digest = requestDigest(request);
    return this.database.transaction((tx) => {
      const now = Date.now();
      const inserted =
        tx
          .insert(operations)
          .values({
            clientOperationId,
            kind,
            target,
            requestDigest: digest,
            state: 'accepted',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: operations.clientOperationId })
          .run().changes === 1;
      const operation = tx
        .select()
        .from(operations)
        .where(eq(operations.clientOperationId, clientOperationId))
        .get();
      if (!operation) throw new Error('Operation insert did not persist');
      if (
        operation.kind !== kind ||
        operation.target !== target ||
        operation.requestDigest !== digest
      ) {
        throw new StoreConflict('OPERATION_CONFLICT', '同一操作 ID 已用于不同的请求');
      }
      return { operation, inserted };
    });
  }

  get(id: string): OperationRow | undefined {
    return this.database
      .select()
      .from(operations)
      .where(eq(operations.clientOperationId, id))
      .get();
  }

  associateProject(id: string, projectId: string | null): void {
    this.database
      .update(operations)
      .set({ projectId })
      .where(and(eq(operations.clientOperationId, id), eq(operations.state, 'accepted')))
      .run();
  }

  /** Includes older rows whose project can be recovered from their stable target/link. */
  pendingProjectOperations(projectId: string | null): OperationRow[] {
    return this.database
      .select()
      .from(operations)
      .where(
        or(
          eq(operations.state, 'accepted'),
          eq(operations.state, 'dispatching'),
          and(eq(operations.state, 'unknown'), isNull(operations.reconciledAt)),
        ),
      )
      .all()
      .filter((operation) => {
        if (
          ![
            'thread.create',
            'thread.resume',
            'thread.fork',
            'thread.archive',
            'thread.rename',
          ].includes(operation.kind)
        )
          return false;
        const owner =
          operation.projectId ??
          (operation.kind === 'thread.create'
            ? operation.target === '@unassigned'
              ? null
              : operation.target
            : this.getThreadLink(operation.target)?.projectId);
        return owner === projectId;
      });
  }

  dispatch(
    id: string,
    marker?: { threadId: string; workspaceKey: string; codexEpoch: string },
  ): void {
    this.database.transaction((tx) => {
      if (marker) {
        const occupied = tx
          .select()
          .from(executionMarkers)
          .where(
            and(isNull(executionMarkers.endedAt), eq(executionMarkers.threadId, marker.threadId)),
          )
          .get();
        if (occupied)
          throw new StoreConflict(
            'THREAD_BUSY',
            '该会话的上一轮执行尚未结束，请追加要求或等待结束',
            occupied.threadId,
          );
      }
      const updated = tx
        .update(operations)
        .set({ state: 'dispatching', updatedAt: Date.now() })
        .where(and(eq(operations.clientOperationId, id), eq(operations.state, 'accepted')))
        .run();
      if (updated.changes !== 1)
        throw new StoreConflict('OPERATION_CONFLICT', '操作已经派发或结束');
      if (marker)
        tx.insert(executionMarkers)
          .values({ operationId: id, ...marker, state: 'active', createdAt: Date.now() })
          .run();
    });
  }

  acknowledge(id: string, result: unknown, turnId?: string): OperationRow {
    this.database.transaction((tx) => {
      tx.update(operations)
        .set({ state: 'acknowledged', result, error: null, updatedAt: Date.now() })
        .where(and(eq(operations.clientOperationId, id), eq(operations.state, 'dispatching')))
        .run();
      if (turnId !== undefined)
        tx.update(executionMarkers)
          .set({ turnId })
          .where(eq(executionMarkers.operationId, id))
          .run();
    });
    return this.get(id)!;
  }

  confirmWorkspaceCreation(id: string, threadId: string): OperationRow {
    const operation = this.get(id)!;
    this.database
      .update(operations)
      .set({
        state: 'acknowledged',
        error: null,
        updatedAt: Date.now(),
        result: {
          threadId,
          ...(operation.kind === 'thread.fork' ? { forkedFromId: operation.target } : {}),
        },
      })
      .where(and(eq(operations.clientOperationId, id), eq(operations.state, 'unknown')))
      .run();
    return this.get(id)!;
  }

  fail(id: string, error: ApiError, uncertain = false): OperationRow {
    this.database.transaction((tx) => {
      const changed = tx
        .update(operations)
        .set({ state: uncertain ? 'unknown' : 'failed', error, updatedAt: Date.now() })
        .where(
          and(
            eq(operations.clientOperationId, id),
            or(eq(operations.state, 'accepted'), eq(operations.state, 'dispatching')),
          ),
        )
        .run();
      // A late rejection must not turn an already-recovered unknown execution into a release.
      if (changed.changes === 0) return;
      tx.update(executionMarkers)
        .set(uncertain ? { state: 'unknown' } : { state: 'terminal', endedAt: Date.now() })
        .where(and(eq(executionMarkers.operationId, id), isNull(executionMarkers.endedAt)))
        .run();
    });
    return this.get(id)!;
  }

  /** Includes acknowledged requests with unfinished turns; none of these are retried. */
  recover(): void {
    this.database.transaction((tx) => {
      tx.update(operations)
        .set({
          state: 'failed',
          error: { code: 'NOT_DISPATCHED', message: '服务在派发前停止；操作没有执行' },
          updatedAt: Date.now(),
        })
        .where(eq(operations.state, 'accepted'))
        .run();
      tx.update(operations)
        .set({
          state: 'unknown',
          error: { code: 'RESULT_UNKNOWN', message: '运行时已停止，提交结果需要核对' },
          updatedAt: Date.now(),
        })
        .where(eq(operations.state, 'dispatching'))
        .run();
      tx.update(executionMarkers)
        .set({ state: 'unknown' })
        .where(isNull(executionMarkers.endedAt))
        .run();
    });
  }

  activeMarkers(): ExecutionMarker[] {
    return this.database
      .select()
      .from(executionMarkers)
      .where(isNull(executionMarkers.endedAt))
      .all();
  }

  unresolvedOperations(): OperationRow[] {
    return this.database
      .select()
      .from(operations)
      .where(
        or(
          eq(operations.state, 'accepted'),
          eq(operations.state, 'dispatching'),
          and(eq(operations.state, 'unknown'), isNull(operations.reconciledAt)),
        ),
      )
      .all();
  }

  capacityRetryTurns(threadId: string): Map<string, string> {
    const rows = this.database
      .select({ result: operations.result })
      .from(operations)
      .where(and(eq(operations.target, threadId), eq(operations.kind, 'turn.start')))
      .all();
    const links = new Map<string, string>();
    for (const { result } of rows) {
      if (typeof result !== 'object' || result === null) continue;
      const value = result as { turnId?: unknown; retryOf?: unknown };
      if (typeof value.turnId === 'string' && typeof value.retryOf === 'string')
        links.set(value.turnId, value.retryOf);
    }
    return links;
  }

  marker(operationId: string): ExecutionMarker | undefined {
    return this.database
      .select()
      .from(executionMarkers)
      .where(eq(executionMarkers.operationId, operationId))
      .get();
  }

  activeForThread(threadId: string): ExecutionMarker | undefined {
    return this.database
      .select()
      .from(executionMarkers)
      .where(and(eq(executionMarkers.threadId, threadId), isNull(executionMarkers.endedAt)))
      .get();
  }

  attachTurn(operationId: string, turnId: string): void {
    this.database
      .update(executionMarkers)
      .set({ turnId })
      .where(and(eq(executionMarkers.operationId, operationId), isNull(executionMarkers.endedAt)))
      .run();
  }

  finishTurn(threadId: string, turnId: string, codexEpoch: string): void {
    this.database
      .update(executionMarkers)
      .set({ state: 'terminal', endedAt: Date.now() })
      .where(
        and(
          eq(executionMarkers.threadId, threadId),
          eq(executionMarkers.turnId, turnId),
          eq(executionMarkers.codexEpoch, codexEpoch),
          isNull(executionMarkers.endedAt),
        ),
      )
      .run();
  }

  /** Keys the release to the original execution; an old decision cannot unlock a later turn. */
  reconcile(targetOperationId: string, reconciliationOperationId: string): void {
    this.database.transaction((tx) => {
      const now = Date.now();
      tx.update(operations)
        .set({ reconciledAt: now, reconciliationDecision: 'confirmed-ended' })
        .where(
          and(eq(operations.clientOperationId, targetOperationId), isNull(operations.reconciledAt)),
        )
        .run();
      tx.update(executionMarkers)
        .set({ state: 'reconciled', endedAt: now, reconciledAt: now, reconciliationOperationId })
        .where(
          and(
            eq(executionMarkers.operationId, targetOperationId),
            isNull(executionMarkers.endedAt),
          ),
        )
        .run();
      tx.update(operations)
        .set({
          state: 'acknowledged',
          result: { targetOperationId, decision: 'confirmed-ended', reconciledAt: now },
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.clientOperationId, reconciliationOperationId),
            eq(operations.state, 'dispatching'),
          ),
        )
        .run();
    });
  }

  linkThread(link: Omit<ThreadLink, 'updatedAt'>): void {
    this.database
      .insert(threadLinks)
      .values({ ...link, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: threadLinks.threadId, set: { ...link, updatedAt: Date.now() } })
      .run();
  }

  getThreadLink(threadId: string): ThreadLink | undefined {
    return this.database.select().from(threadLinks).where(eq(threadLinks.threadId, threadId)).get();
  }
}

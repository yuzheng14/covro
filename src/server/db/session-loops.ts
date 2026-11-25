import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { AppError } from '../../shared/errors.js';
import type {
  SessionLoop,
  SessionLoopAction,
  SessionLoopReason,
  SessionLoopResult,
} from '../../shared/session-loop.js';
import type { AppDatabase, AppTransaction } from './index.js';
import { sessionLoops } from './schema.js';

export type SessionLoopRow = typeof sessionLoops.$inferSelect;

export function sessionLoopView({
  workspaceKey: _workspaceKey,
  settings: _settings,
  lastOperationId: _lastOperationId,
  ...view
}: SessionLoopRow): SessionLoop {
  return view;
}

export class SessionLoopStore {
  constructor(private readonly db: AppDatabase) {}

  list(threadId: string, workspaceKey: string): SessionLoop[] {
    return this.db
      .select()
      .from(sessionLoops)
      .where(and(eq(sessionLoops.threadId, threadId), eq(sessionLoops.workspaceKey, workspaceKey)))
      .orderBy(asc(sessionLoops.nextRunAt), asc(sessionLoops.id))
      .all()
      .map(sessionLoopView);
  }

  threadIds(): string[] {
    return this.db
      .selectDistinct({ id: sessionLoops.threadId })
      .from(sessionLoops)
      .all()
      .map(({ id }) => id);
  }

  get(id: string): SessionLoopRow | undefined {
    return this.db.select().from(sessionLoops).where(eq(sessionLoops.id, id)).get();
  }

  due(now: number): SessionLoopRow[] {
    return this.db
      .select()
      .from(sessionLoops)
      .where(and(eq(sessionLoops.status, 'active'), lte(sessionLoops.nextRunAt, now)))
      .orderBy(asc(sessionLoops.nextRunAt), asc(sessionLoops.id))
      .all();
  }

  unfinished(): SessionLoopRow[] {
    return this.db
      .select()
      .from(sessionLoops)
      .where(inArray(sessionLoops.lastResult, ['running', 'unknown']))
      .all();
  }

  byRun(operationId: string): SessionLoopRow | undefined {
    return this.db
      .select()
      .from(sessionLoops)
      .where(eq(sessionLoops.lastOperationId, operationId))
      .get();
  }

  create(tx: AppTransaction, row: typeof sessionLoops.$inferInsert): void {
    tx.insert(sessionLoops).values(row).run();
  }

  control(tx: AppTransaction, row: SessionLoopRow, action: SessionLoopAction, now: number): void {
    const status = action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled';
    const updated = tx
      .update(sessionLoops)
      .set({
        status,
        reason: null,
        version: row.version + 1,
        ...(action === 'resume' ? { nextRunAt: now + row.intervalMs } : {}),
      })
      .where(and(eq(sessionLoops.id, row.id), eq(sessionLoops.version, row.version)))
      .run();
    if (updated.changes !== 1) throw new AppError('LOOP_CONFLICT', 'The loop has changed', 409);
  }

  claim(tx: AppTransaction, row: SessionLoopRow, operationId: string, now: number): void {
    const updated = tx
      .update(sessionLoops)
      .set({
        runs: row.runs + 1,
        lastStartedAt: now,
        lastResult: 'running',
        lastOperationId: operationId,
        lastTurnId: null,
        nextRunAt: now + row.intervalMs,
      })
      .where(
        and(
          eq(sessionLoops.id, row.id),
          eq(sessionLoops.status, 'active'),
          eq(sessionLoops.version, row.version),
          eq(sessionLoops.runs, row.runs),
          lte(sessionLoops.nextRunAt, now),
        ),
      )
      .run();
    if (updated.changes !== 1)
      throw new AppError('LOOP_CONFLICT', 'The loop is no longer due', 409);
  }

  retry(tx: AppTransaction, loopId: string, previousId: string, operationId: string): void {
    const updated = tx
      .update(sessionLoops)
      .set({ lastOperationId: operationId, lastTurnId: null })
      .where(
        and(
          eq(sessionLoops.id, loopId),
          eq(sessionLoops.lastOperationId, previousId),
          eq(sessionLoops.status, 'active'),
        ),
      )
      .run();
    if (updated.changes !== 1)
      throw new AppError('LOOP_CONFLICT', 'The loop is no longer retryable', 409);
  }

  record(row: SessionLoopRow, result: SessionLoopResult, turnId: string | null): void {
    if (!row.lastOperationId) return;
    this.db
      .update(sessionLoops)
      .set({ lastResult: result, lastTurnId: turnId ?? row.lastTurnId })
      .where(
        and(eq(sessionLoops.id, row.id), eq(sessionLoops.lastOperationId, row.lastOperationId)),
      )
      .run();
  }

  suspend(row: SessionLoopRow, reason: SessionLoopReason): void {
    this.db
      .update(sessionLoops)
      .set({
        status: reason === 'deleted' ? 'cancelled' : 'paused',
        reason,
        version: row.version + 1,
      })
      .where(
        and(
          eq(sessionLoops.id, row.id),
          eq(sessionLoops.status, 'active'),
          eq(sessionLoops.version, row.version),
        ),
      )
      .run();
  }

  archive(threadId: string): void {
    this.db
      .update(sessionLoops)
      .set({ status: 'paused', reason: 'archived', version: sql`${sessionLoops.version} + 1` })
      .where(and(eq(sessionLoops.threadId, threadId), eq(sessionLoops.status, 'active')))
      .run();
  }

  skipMissed(now: number): void {
    this.db
      .update(sessionLoops)
      .set({ nextRunAt: sql`${now} + ${sessionLoops.intervalMs}` })
      .where(and(eq(sessionLoops.status, 'active'), lt(sessionLoops.nextRunAt, now)))
      .run();
  }
}

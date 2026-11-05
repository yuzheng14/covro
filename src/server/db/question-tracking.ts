import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from './index.js';
import { operations, questionTracking, questionActionHistory } from './schema.js';
import type { PendingAction, ThreadView } from '../../shared/types.js';

/** Only local disposition and reply claims live here. Native history owns actual answers. */
export class QuestionTrackingStore {
  constructor(private readonly database: AppDatabase) {}

  saveAction(action: PendingAction, answers?: Record<string, { answers: string[] }>) {
    if (!action.threadId) return;
    const existing = this.database
      .select()
      .from(questionActionHistory)
      .where(eq(questionActionHistory.actionId, action.actionId))
      .get();
    if (!answers && existing?.action.questionAnswers) return;
    const saved = {
      ...action,
      // Historical requests cannot regain liveness after reconnect/restart from a saved card.
      status:
        answers || action.status === 'responded' ? ('responded' as const) : ('expired' as const),
      ...(answers
        ? {
            questionAnswers: Object.fromEntries(
              (action.questions ?? []).map((question) => [
                question.id,
                question.isSecret && answers[question.id]!.answers.length
                  ? ['••••']
                  : answers[question.id]!.answers,
              ]),
            ),
          }
        : {}),
    };
    this.database
      .insert(questionActionHistory)
      .values({
        actionId: action.actionId,
        threadId: action.threadId,
        action: saved,
      })
      .onConflictDoUpdate({ target: questionActionHistory.actionId, set: { action: saved } })
      .run();
  }

  actions(threadId: string): PendingAction[] {
    return this.database
      .select()
      .from(questionActionHistory)
      .where(eq(questionActionHistory.threadId, threadId))
      .all()
      .map((row) => row.action);
  }

  states(threadId: string): NonNullable<ThreadView['questionTracking']> {
    const rows = this.database
      .select({
        id: questionTracking.questionId,
        state: questionTracking.state,
        updatedAt: questionTracking.updatedAt,
        operationState: operations.state,
      })
      .from(questionTracking)
      .leftJoin(operations, eq(questionTracking.operationId, operations.clientOperationId))
      .where(eq(questionTracking.threadId, threadId))
      .all();
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (row.state === 'submitting' && row.operationState === 'failed') return [];
        return [
          [
            row.id,
            {
              status:
                row.state === 'submitting' && row.operationState === 'unknown'
                  ? 'unknown'
                  : row.state,
              updatedAt: row.updatedAt,
            },
          ],
        ];
      }),
    );
  }

  save(threadId: string, ids: string[], state: 'dismissed' | 'submitting', operationId: string) {
    this.database.transaction((tx) => {
      for (const questionId of ids)
        tx.insert(questionTracking)
          .values({
            threadId,
            questionId,
            state,
            operationId,
            updatedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: [questionTracking.threadId, questionTracking.questionId],
            set: { state, operationId, updatedAt: Date.now() },
          })
          .run();
    });
  }

  release(operationId: string) {
    this.database
      .delete(questionTracking)
      .where(
        and(
          eq(questionTracking.operationId, operationId),
          eq(questionTracking.state, 'submitting'),
        ),
      )
      .run();
  }
}

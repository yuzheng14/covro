import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from './index.js';
import { turnCompletionReads } from './schema.js';

export class TurnCompletionReads {
  constructor(private readonly database: AppDatabase) {}

  has(threadId: string, turnId: string): boolean {
    return (
      this.database
        .select({ turnId: turnCompletionReads.turnId })
        .from(turnCompletionReads)
        .where(
          and(eq(turnCompletionReads.threadId, threadId), eq(turnCompletionReads.turnId, turnId)),
        )
        .get() !== undefined
    );
  }

  record(threadId: string, turnId: string): boolean {
    return (
      this.database
        .insert(turnCompletionReads)
        .values({ threadId, turnId })
        .onConflictDoNothing()
        .run().changes > 0
    );
  }
}

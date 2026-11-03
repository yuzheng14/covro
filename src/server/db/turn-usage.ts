import { eq } from 'drizzle-orm';
import type { AppDatabase } from './index.js';
import { turnUsage, turnTokenTotals } from './schema.js';
import type { TurnView } from '../../shared/types.js';

export class TurnUsageStore {
  constructor(private readonly database: AppDatabase) {}

  save(threadId: string, turn: TurnView): void {
    if (
      turn.totalTokens !== undefined &&
      Number.isSafeInteger(turn.totalTokens) &&
      turn.totalTokens >= 0
    )
      this.database
        .insert(turnTokenTotals)
        .values({ threadId, turnId: turn.id, totalTokens: turn.totalTokens })
        .onConflictDoNothing()
        .run();
    if (
      turn.outputTokens === undefined ||
      !Number.isSafeInteger(turn.outputTokens) ||
      turn.outputTokens < 0
    )
      return;
    this.database
      .insert(turnUsage)
      .values({
        threadId,
        turnId: turn.id,
        outputTokens: turn.outputTokens,
      })
      .onConflictDoNothing()
      .run();
  }

  restore(threadId: string, turns: TurnView[]): TurnView[] {
    if (turns.length === 0) return turns;
    const saved = new Map(
      this.database
        .select()
        .from(turnUsage)
        .where(eq(turnUsage.threadId, threadId))
        .all()
        .map((entry) => [entry.turnId, entry.outputTokens]),
    );
    const totals = new Map(
      this.database
        .select()
        .from(turnTokenTotals)
        .where(eq(turnTokenTotals.threadId, threadId))
        .all()
        .map((entry) => [entry.turnId, entry.totalTokens]),
    );
    return turns.map((turn) => {
      const outputTokens = saved.get(turn.id);
      const totalTokens = totals.get(turn.id);
      if (outputTokens === undefined && totalTokens === undefined) return turn;
      return {
        ...turn,
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      };
    });
  }
}

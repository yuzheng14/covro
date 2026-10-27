export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export type GoalMutation =
  | {
      action: 'set';
      objective?: string;
      status?: 'active' | 'paused' | 'complete';
      tokenBudget?: number;
    }
  | { action: 'clear' };

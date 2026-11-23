export const restartBlockers = [
  'running',
  'approval',
  'input',
  'clone',
  'shell',
  'retry',
  'operation',
  'maintenance',
] as const;
export type RestartBlocker = (typeof restartBlockers)[number];

export const restartRecoveryMs = 90_000;

export interface RestartRequest {
  clientOperationId: string;
  afterId: string | null;
}

export interface RestartRun {
  id: string;
  phase: 'waiting' | 'restarting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: number;
  recoveryDeadline?: number;
  failure?:
    | 'timedOut'
    | 'config'
    | 'identity'
    | 'launch'
    | 'shutdown'
    | 'interrupted'
    | 'startup'
    | 'codex'
    | 'storage'
    | 'activity';
}

export interface RestartStatus {
  supported: boolean;
  blockers: RestartBlocker[];
  run?: RestartRun;
}

export interface RestartController {
  status(): RestartStatus;
  start(input: RestartRequest): Promise<{ restartId: string }>;
  cancel(id: string): Promise<RestartStatus>;
}

export const restartActive = (run?: RestartRun) =>
  run?.phase === 'waiting' || run?.phase === 'restarting' || run?.phase === 'verifying';

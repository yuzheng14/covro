import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  operationId?: string;
  threadId?: string;
  sourceThreadId?: string;
  turnId?: string;
  jobId?: string;
  codexEpoch?: string;
}
const context = new AsyncLocalStorage<LogContext>();
export const logContext = (): LogContext => context.getStore() ?? {};
export function withLogContext<T>(fields: LogContext, run: () => T): T {
  return context.run({ ...logContext(), ...fields }, run);
}

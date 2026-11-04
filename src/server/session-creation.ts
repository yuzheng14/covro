import type { OperationStore } from './db/operations.js';

export interface SessionCreationResult {
  creationOperationId: string;
  promptOperationId: string;
  stage: 'creating' | 'created' | 'submitted';
  threadId?: string;
  turnId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Child receipts remain authoritative even if the parent stopped before saving its result. */
export function sessionCreationResult(
  store: OperationStore,
  value: unknown,
): SessionCreationResult {
  const saved = record(value);
  const creationOperationId = String(saved.creationOperationId ?? '');
  const promptOperationId = String(saved.promptOperationId ?? '');
  const creation = creationOperationId ? store.get(creationOperationId) : undefined;
  const prompt = promptOperationId ? store.get(promptOperationId) : undefined;
  const created = record(creation?.result);
  const submitted = record(prompt?.result);
  const threadId = typeof created.threadId === 'string' ? created.threadId : undefined;
  const turnId = typeof submitted.turnId === 'string' ? submitted.turnId : undefined;
  return {
    creationOperationId,
    promptOperationId,
    stage: turnId ? 'submitted' : threadId ? 'created' : 'creating',
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

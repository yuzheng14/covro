import type { TurnErrorMetadata, TurnView } from './types.js';

export const MODEL_CAPACITY_MESSAGE =
  'Selected model is at capacity. Please try a different model.';

/** Called only for actual upstream errors, never for conversation content. */
export function isModelCapacityError(message: string, code?: string): boolean {
  return (
    code === 'serverOverloaded' ||
    ((!code || code === 'other') && message.trim() === MODEL_CAPACITY_MESSAGE)
  );
}

export function capacityRetryNotice(error: TurnErrorMetadata & { message: string }): boolean {
  return (
    isModelCapacityError(error.message, error.errorCode) ||
    error.errorDetails?.trim() === MODEL_CAPACITY_MESSAGE
  );
}

export function upstreamRetryAttempt(message: string) {
  const match = /^Reconnecting(?:\.{3}|…)\s+(\d+)\/(\d+)(?:\s|$)/.exec(message);
  if (!match) return undefined;
  const attempt = Number(match[1]);
  const limit = Number(match[2]);
  return Number.isSafeInteger(attempt) &&
    Number.isSafeInteger(limit) &&
    attempt > 0 &&
    attempt <= limit &&
    limit <= 100
    ? { attempt, limit }
    : undefined;
}

export function isCapacityTurnError(turn: TurnView): boolean {
  return (
    Boolean(turn.reconnect && capacityRetryNotice(turn.reconnect)) ||
    Boolean(turn.error && isModelCapacityError(turn.error, turn.errorCode))
  );
}

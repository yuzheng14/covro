/** Only explicitly approved metadata can cross the logging boundary. Never log payloads. */
export type LogFields = Record<string, unknown>;
const identifiers = new Set([
  'component',
  'requestId',
  'operationId',
  'threadId',
  'sourceThreadId',
  'turnId',
  'jobId',
  'codexEpoch',
  'temporaryThreadId',
  'connectionId',
  'rpcId',
  'backupId',
  'updateId',
  'cloneId',
  'actionId',
]);
const labels = new Set([
  'stage',
  'outcome',
  'reason',
  'errorCode',
  'errorType',
  'method',
  'route',
  'model',
  'provider',
  'version',
  'codexVersion',
  'signal',
  'kind',
  'state',
  'previousState',
]);
const numbers = new Set([
  'durationMs',
  'status',
  'rpcCode',
  'attempt',
  'timeoutMs',
  'exitCode',
  'pendingRequests',
  'receivedBytes',
  'maxLineBytes',
  'outputBytes',
  'inputBytes',
  'bufferedBytes',
  'limitBytes',
  'droppedRecords',
  'count',
  'port',
]);
const flags = new Set(['uncertain', 'willRetry', 'ephemeral', 'replayed', 'truncated']);

export function safeFields(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (identifiers.has(key) && (typeof value === 'string' || typeof value === 'number')) {
      // IDs cannot contain prose, URLs, paths or injected log lines.
      const text = String(value);
      if (/^[a-zA-Z0-9_.:-]{1,160}$/.test(text)) safe[key] = text;
    } else if (labels.has(key) && typeof value === 'string') {
      if (/^[a-zA-Z0-9_./:@+ -]{1,180}$/.test(value) && !value.includes('://')) safe[key] = value;
    } else if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
    } else if (flags.has(key) && typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

/** Exception text, stack, cause and details can contain prompts or credentials. */
export function errorFields(error: unknown): LogFields {
  if (!error || typeof error !== 'object') return { errorCode: 'UNKNOWN_ERROR' };
  const value = error as { code?: unknown; rpcCode?: unknown; uncertain?: unknown; name?: unknown };
  return safeFields({
    errorCode:
      typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
        ? value.code
        : 'UNEXPECTED_ERROR',
    errorType:
      typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.name)
        ? value.name
        : 'Error',
    rpcCode: value.rpcCode,
    uncertain: value.uncertain,
  });
}

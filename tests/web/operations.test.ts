import { describe, expect, it } from 'vitest';
import {
  blocksTarget,
  canDiscardMissingOperation,
  operationLookupError,
  operationThreadId,
  isSettled,
  needsReconciliation,
  readOperations,
  saveOperations,
  type SavedOperation,
} from '../../src/web/lib/operations';
import { HttpError } from '../../src/web/lib/api';

describe('missing operation receipts', () => {
  it('requires the operation-specific 404 before offering local dismissal', () => {
    const missing = operationLookupError(
      new HttpError(404, { code: 'OPERATION_NOT_FOUND', message: '未找到该操作' }),
    );
    expect(missing.missing).toBe(true);
    expect(missing.message).toContain('不能证明任务没有执行');
    for (const problem of [
      new HttpError(404, { code: 'NOT_FOUND', message: '路由不存在' }),
      new HttpError(503, { code: 'UNAVAILABLE', message: '不可用' }),
      new Error('Failed to fetch'),
    ])
      expect(operationLookupError(problem).missing).toBe(false);
    const entry: SavedOperation = {
      clientOperationId: 'missing',
      kind: 'send',
      target: 'thread',
      createdAt: 1,
      status: 'unknown',
      lookupError: missing,
    };
    expect(blocksTarget(entry, 'thread')).toBe(true);
    expect(canDiscardMissingOperation(entry)).toBe(true);
    expect(canDiscardMissingOperation({ ...entry, status: 'accepted' })).toBe(false);
    expect(
      canDiscardMissingOperation({
        ...entry,
        operation: {
          clientOperationId: 'missing',
          kind: 'turn.start',
          target: 'thread',
          status: 'unknown',
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    ).toBe(false);
    let saved = '';
    saveOperations([entry], {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restored = readOperations({ getItem: () => saved })[0]!;
    expect(restored.lookupError).toBeUndefined();
    expect(canDiscardMissingOperation(restored)).toBe(false);
    expect(blocksTarget(restored, 'thread')).toBe(true);
  });
});

describe('durable operation identity', () => {
  it('persists uncertain IDs and targets across refresh without persisting prompts or projections', () => {
    let data = '';
    const storage = {
      setItem: (_key: string, value: string) => {
        data = value;
      },
      getItem: () => data,
    };
    const entry: SavedOperation = {
      clientOperationId: 'operation-id',
      kind: 'send',
      target: 'thread-id',
      createdAt: 1,
      status: 'acknowledged',
      operation: {
        clientOperationId: 'operation-id',
        kind: 'turn.start',
        target: 'thread-id',
        status: 'acknowledged',
        result: { sensitive: 'prompt should not persist' },
        createdAt: 1,
        updatedAt: 2,
      },
    };
    expect(saveOperations([entry], storage)).toBe(true);
    expect(data).not.toContain('sensitive');
    expect(readOperations(storage)).toEqual([
      {
        clientOperationId: 'operation-id',
        kind: 'send',
        target: 'thread-id',
        createdAt: 1,
        status: 'unknown',
      },
    ]);
  });
  it('handles disabled storage and corrupt prior preferences without crashing', () => {
    expect(
      saveOperations([], {
        setItem: () => {
          throw new Error('disabled');
        },
      }),
    ).toBe(false);
    expect(readOperations({ getItem: () => '{invalid' })).toEqual([]);
    expect(readOperations({ getItem: () => '[null, {"target":123}]' })).toEqual([]);
  });
  it('preserves fork identity and cancelled navigation while discarding response projections', () => {
    let data = '';
    const storage = {
      setItem: (_key: string, value: string) => {
        data = value;
      },
      getItem: () => data,
    };
    const entry: SavedOperation = {
      clientOperationId: 'fork-id',
      kind: 'fork',
      target: 'source-thread',
      projectId: 'project',
      createdAt: 1,
      status: 'unknown',
      navigateToResult: false,
      navigationSource: { projectId: 'other-project', threadId: 'selected-thread' },
      error: 'Response details are not durable',
    };
    expect(saveOperations([entry], storage)).toBe(true);
    expect(readOperations(storage)).toEqual([{ ...entry, error: undefined }]);
    expect(data).not.toContain('Response details');
    expect(blocksTarget(readOperations(storage)[0]!, 'source-thread')).toBe(true);
  });
  it('retains unknown audit state without blocking new work after explicit reconciliation', () => {
    const entry: SavedOperation = {
      clientOperationId: 'old',
      kind: 'send',
      target: 'thread',
      createdAt: 1,
      status: 'unknown',
    };
    expect(blocksTarget(entry, 'thread')).toBe(true);
    entry.operation = {
      clientOperationId: 'old',
      kind: 'turn.start',
      target: 'thread',
      status: 'unknown',
      createdAt: 1,
      updatedAt: 2,
      reconciliation: { at: 2, decision: 'confirmed-ended' },
    };
    expect(blocksTarget(entry, 'thread')).toBe(false);
    expect(entry.operation.status).toBe('unknown');
  });
  it('persists cancelled create navigation so a late receipt cannot reopen a previous project', () => {
    let data = '';
    const storage = {
      setItem: (_key: string, value: string) => {
        data = value;
      },
      getItem: () => data,
    };
    const operation: SavedOperation = {
      clientOperationId: 'create',
      kind: 'create',
      target: 'a',
      projectId: 'a',
      createdAt: 1,
      status: 'unknown',
      navigateToResult: false,
    };
    saveOperations([operation], storage);
    expect(readOperations(storage)).toEqual([operation]);
  });
  it('allows follow-up after terminal evidence while retaining an uncertain submission receipt', () => {
    const entry: SavedOperation = {
      clientOperationId: 'old',
      kind: 'send',
      target: 'thread',
      createdAt: 1,
      status: 'unknown',
      operation: {
        clientOperationId: 'old',
        kind: 'turn.start',
        target: 'thread',
        status: 'unknown',
        createdAt: 1,
        updatedAt: 2,
        execution: {
          operationId: 'old',
          threadId: 'thread',
          turnId: 'turn',
          workspaceKey: '/project',
          codexEpoch: 'old',
          ended: false,
        },
      },
    };
    expect(blocksTarget(entry, 'thread')).toBe(true);
    entry.operation!.execution!.ended = true;
    expect(blocksTarget(entry, 'thread')).toBe(false);
    expect(entry.operation!.status).toBe('unknown');
  });
});

it('persists only the archive intent needed for reconciliation', () => {
  let data = '';
  const storage = {
    getItem: () => data,
    setItem: (_key: string, value: string) => {
      data = value;
    },
  };
  saveOperations(
    [
      {
        clientOperationId: 'archive',
        kind: 'archive',
        target: 'thread',
        createdAt: 1,
        status: 'accepted',
        mutation: { projectId: 'project', archived: true },
      },
    ],
    storage,
  );
  expect(readOperations(storage)[0]).toMatchObject({
    status: 'unknown',
    mutation: { projectId: 'project', archived: true },
  });
});

it('restores a pending rename with only its validated display name and identity', () => {
  let data = '';
  const storage = {
    getItem: () => data,
    setItem: (_key: string, value: string) => {
      data = value;
    },
  };
  const entry: SavedOperation = {
    clientOperationId: 'rename',
    kind: 'rename',
    target: 'thread',
    createdAt: 1,
    status: 'accepted',
    mutation: { projectId: 'project', title: '新名称' },
  };
  saveOperations([entry], storage);
  expect(readOperations(storage)[0]?.mutation).toEqual({ projectId: 'project', title: '新名称' });
  data = data.replace('新名称', '名'.repeat(101));
  expect(readOperations(storage)[0]?.mutation).toBeUndefined();
});

it('preserves approval ownership across reload without persisting response content', () => {
  let saved = '';
  const entry: SavedOperation = {
    clientOperationId: 'approval-submission',
    kind: 'resolve',
    target: 'action',
    createdAt: 1,
    status: 'unknown',
    context: { threadId: 'thread', projectId: 'project', title: 'Review the change' },
  };
  saveOperations([entry], {
    setItem: (_key, value) => {
      saved = value;
    },
  });
  const restored = readOperations({ getItem: () => saved })[0]!;
  expect(restored.context).toEqual(entry.context);
  expect(operationThreadId(restored)).toBe('thread');
  expect(operationThreadId({ ...restored, context: undefined })).toBeUndefined();
  expect(
    operationThreadId({ ...restored, kind: 'create', target: 'project', context: undefined }),
  ).toBeUndefined();
  expect(
    readOperations({ getItem: () => JSON.stringify([{ ...entry, context: { threadId: 42 } }]) })[0]
      ?.context,
  ).toBeUndefined();
});

it('removes a terminal execution from pending work while leaving its original receipt unknown', () => {
  const entry: SavedOperation = {
    clientOperationId: 'old',
    kind: 'send',
    target: 'thread',
    createdAt: 1,
    status: 'unknown',
    operation: {
      clientOperationId: 'old',
      kind: 'turn.start',
      target: 'thread',
      status: 'unknown',
      createdAt: 1,
      updatedAt: 2,
      execution: {
        operationId: 'old',
        threadId: 'thread',
        turnId: 'turn',
        workspaceKey: 'workspace',
        codexEpoch: 'epoch',
        ended: true,
      },
    },
  };
  expect(isSettled(entry.operation!)).toBe(true);
  expect(needsReconciliation(entry)).toBe(false);
  expect(blocksTarget(entry, 'thread')).toBe(false);
  expect(entry.operation!.status).toBe('unknown');
});

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { ApiError, ItemView, PendingUserMessage } from '../../shared/types.js';

export const operations = sqliteTable(
  'operations',
  {
    clientOperationId: text('client_operation_id').primaryKey(),
    kind: text('kind').notNull(),
    target: text('target').notNull(),
    projectId: text('project_id'),
    requestDigest: text('request_digest').notNull(),
    state: text('state', {
      enum: ['accepted', 'dispatching', 'acknowledged', 'failed', 'unknown'],
    }).notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error', { mode: 'json' }).$type<ApiError>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    reconciledAt: integer('reconciled_at'),
    reconciliationDecision: text('reconciliation_decision'),
  },
  (table) => [
    check(
      'operations_state_check',
      sql`${table.state} in ('accepted', 'dispatching', 'acknowledged', 'failed', 'unknown')`,
    ),
    index('operations_state_idx').on(table.state),
  ],
);

export const executionMarkers = sqliteTable(
  'execution_markers',
  {
    operationId: text('operation_id')
      .primaryKey()
      .references(() => operations.clientOperationId),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    workspaceKey: text('workspace_key').notNull(),
    codexEpoch: text('codex_epoch').notNull(),
    state: text('state', { enum: ['active', 'unknown', 'terminal', 'reconciled'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    endedAt: integer('ended_at'),
    reconciledAt: integer('reconciled_at'),
    reconciliationOperationId: text('reconciliation_operation_id').references(
      () => operations.clientOperationId,
    ),
  },
  (table) => [
    check(
      'execution_markers_state_check',
      sql`${table.state} in ('active', 'unknown', 'terminal', 'reconciled')`,
    ),
    uniqueIndex('execution_markers_active_thread')
      .on(table.threadId)
      .where(sql`${table.endedAt} is null`),
  ],
);

/** Temporary submission snapshots; native Codex history remains authoritative. */
export const pendingUserMessages = sqliteTable(
  'pending_user_messages',
  {
    id: text('id')
      .primaryKey()
      .references(() => operations.clientOperationId),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    item: text('item', { mode: 'json' }).$type<ItemView>().notNull(),
    status: text('status').$type<PendingUserMessage['status']>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('pending_user_messages_thread_idx').on(table.threadId),
    check(
      'pending_user_messages_status_check',
      sql`${table.status} in ('submitting', 'submitted', 'unknown', 'failed')`,
    ),
  ],
);

export const threadLinks = sqliteTable('thread_links', {
  threadId: text('thread_id').primaryKey(),
  projectId: text('project_id'),
  cwd: text('cwd').notNull(),
  source: text('source').notNull(),
  managedEpoch: text('managed_epoch'),
  updatedAt: integer('updated_at').notNull(),
});

/** Allocations survive failed/unknown RPCs; names and archive state remain in Codex. */
export const sessionWorkspaces = sqliteTable('session_workspaces', {
  operationId: text('operation_id').primaryKey(),
  threadId: text('thread_id').unique(),
  rootPath: text('root_path').notNull(),
  canonicalRoot: text('canonical_root').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

/** Locally observed turn totals; upstream turn history does not include token usage. */
export const turnUsage = sqliteTable(
  'turn_usage',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    outputTokens: integer('output_tokens').notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.turnId] })],
);

/** Total input + output tokens observed across a complete turn. Older rows remain unknown. */
export const turnTokenTotals = sqliteTable(
  'turn_token_totals',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    totalTokens: integer('total_tokens').notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.turnId] })],
);

/** Removing a registration retains its identity and all existing thread links. */
export const projectRegistrations = sqliteTable('project_registrations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  canonicalRoot: text('canonical_root'),
  removedAt: integer('removed_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

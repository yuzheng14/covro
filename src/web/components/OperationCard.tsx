import { useState } from 'react';
import type { ThreadView } from '../../shared/types';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import {
  canDiscardMissingOperation,
  needsReconciliation,
  operationThreadId,
  type SavedOperation,
} from '../lib/operations';
import { formatTime } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
import { ThreadId } from './ThreadId';
import { isActive, runStatusLabels } from './Status';
import { Button } from './ui/button';

export function operationName(kind: string) {
  const key: Record<string, string> = {
    send: 'send',
    steer: 'steer',
    resolve: 'resolve',
    fork: 'fork',
    create: 'create',
    resume: 'resume',
    archive: 'archive',
    rename: 'rename',
    compact: 'compact',
    review: 'review',
    interrupt: 'interrupt',
    liveSettings: 'settings',
  };
  return t(`errors:recovery_operation_${key[kind] ?? 'other'}`);
}

export function operationReason(entry: SavedOperation) {
  if (entry.lookupError?.missing) return t('errors:recovery_missing');
  if (entry.lookupError) return t('errors:recovery_unreachable');
  if (entry.operation?.execution && !entry.operation.execution.ended)
    return t('errors:recovery_execution_unknown');
  return t('errors:recovery_receipt_unknown');
}

export function OperationCard({
  entry,
  owner,
  projectName,
  thread,
  selectedId,
  onOpenThread,
  onReconcile,
  onDiscardMissing,
  onRefresh,
  busy,
  refreshing,
  focused,
}: {
  entry: SavedOperation;
  owner?: Pick<ThreadView, 'id' | 'title' | 'projectId' | 'status'> & { lastTurnId?: string };
  projectName: string;
  thread?: ThreadView;
  selectedId?: string;
  onOpenThread: (id: string, projectId?: string | null) => void;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  onRefresh: () => void;
  busy: boolean;
  refreshing: boolean;
  focused: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const threadId = operationThreadId(entry);
  const execution = entry.operation?.execution;
  const current = Boolean(threadId && threadId === selectedId && thread?.id === threadId);
  const fork = entry.kind === 'fork';
  const responding =
    current &&
    entry.kind === 'resolve' &&
    thread?.actions.some(
      (action) => action.actionId === entry.target && action.status === 'responding',
    );
  const active =
    !fork &&
    current &&
    thread &&
    (entry.kind === 'resolve'
      ? responding
      : isActive(thread.status) &&
        (execution
          ? thread.execution?.operationId === execution.operationId ||
            thread.turns.some((turn) => turn.id === execution.turnId && isActive(turn.status))
          : entry.target === thread.id));
  const otherActive =
    !current &&
    execution?.turnId &&
    owner?.lastTurnId === execution.turnId &&
    isActive(owner.status);
  const discard = canDiscardMissingOperation(entry);
  const canRecover =
    (current || !threadId) &&
    !active &&
    !busy &&
    entry.kind !== 'confirmCompatibility' &&
    needsReconciliation(entry) &&
    (discard || (!entry.lookupError && Boolean(entry.operation)));
  const title =
    owner?.title ||
    entry.context?.title ||
    (entry.kind === 'create'
      ? t('common:session_not_created_yet')
      : t('errors:recovery_thread_unavailable'));
  const recoverLabel = discard
    ? t('errors:recovery_clear_local')
    : fork
      ? t('errors:reconcile_this_fork')
      : t('errors:recovery_restore_session');
  return (
    <article
      className={`operation-card${focused ? ' operation-card-focused' : ''}`}
      data-operation-id={entry.clientOperationId}
      aria-label={`${operationName(entry.kind)} · ${title}`}
      tabIndex={-1}
    >
      <div className="operation-title">
        <strong>{operationName(entry.kind)}</strong>
        <span>{formatTime(entry.createdAt)}</span>
      </div>
      <div className="operation-owner">
        <span>{projectName}</span>
        <strong>{title}</strong>
      </div>
      <p className="operation-explanation">
        {responding
          ? t('errors:recovery_responding')
          : active || otherActive
            ? `${runStatusLabels[(current ? thread : owner)!.status]} · ${t('errors:recovery_running')}`
            : operationReason(entry)}
      </p>
      {entry.recoveryError && (
        <p className="inline-error" role="alert">
          {displayMessage(entry.recoveryError)}
        </p>
      )}
      <div className="operation-actions">
        {threadId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onOpenThread(threadId, owner ? owner.projectId : entry.context?.projectId)
            }
          >
            {current ? t('errors:recovery_view_history') : t('errors:recovery_open_thread')}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={refreshing || busy} onClick={onRefresh}>
          {t('errors:recovery_check_again')}
        </Button>
        {canRecover && (
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={() => setConfirming(true)}
          >
            {recoverLabel}…
          </Button>
        )}
      </div>
      {!current && threadId && <p className="subtle">{t('errors:recovery_go_to_thread')}</p>}
      {entry.lookupError && !discard && (
        <p className="subtle">{t('errors:recovery_retry_connection')}</p>
      )}
      {!threadId && entry.kind === 'resolve' && (
        <p className="subtle">{t('errors:recovery_action_owner_missing')}</p>
      )}
      <details className="raw-details">
        <summary>{t('common:technical_details')}</summary>
        <dl>
          <dt>{t('errors:operation')}</dt>
          <dd>{entry.kind}</dd>
          <dt>{t('errors:target')}</dt>
          <dd>{entry.target}</dd>
          <dt>{t('errors:operation_id')}</dt>
          <dd>{entry.clientOperationId}</dd>
          {threadId && (
            <>
              <dt>Thread ID</dt>
              <dd>
                <ThreadId id={threadId} />
              </dd>
            </>
          )}
          {execution && (
            <>
              <dt>{t('errors:workspace')}</dt>
              <dd>{execution.workspaceKey}</dd>
              <dt>{t('errors:execution_status')}</dt>
              <dd>{execution.ended ? t('errors:finished') : t('errors:end_not_confirmed')}</dd>
            </>
          )}
        </dl>
        {entry.error && <p>{displayMessage(entry.error)}</p>}
        {entry.lookupError && <p>{entry.lookupError.message}</p>}
        {entry.lookupError?.details && <pre>{entry.lookupError.details}</pre>}
      </details>
      {confirming && (
        <CommandDialog open title={recoverLabel} onClose={() => setConfirming(false)}>
          <p className="recovery-dialog-owner">
            {projectName} · {title}
          </p>
          <p>
            {discard
              ? t('errors:recovery_clear_effect')
              : fork
                ? t('errors:recovery_fork_effect')
                : t('errors:recovery_restore_effect')}
          </p>
          <div className="operation-actions">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </Button>
            <Button
              disabled={busy || refreshing}
              onClick={() => {
                setConfirming(false);
                if (discard) onDiscardMissing(entry.clientOperationId);
                else onReconcile(entry.clientOperationId);
              }}
            >
              {discard
                ? t('errors:recovery_clear_local')
                : fork
                  ? t('errors:reconcile_this_fork')
                  : t('errors:recovery_confirm_ended')}
            </Button>
          </div>
        </CommandDialog>
      )}
    </article>
  );
}

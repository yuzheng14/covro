import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { Project, SystemInfo, ThreadSummary, ThreadView } from '../../shared/types';
import type { SavedOperation } from '../lib/operations';
import { operationThreadId } from '../lib/operations';
import { api } from '../lib/api';
import { OperationCard } from './OperationCard';
import type { ConnectionState } from '../lib/realtime';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ThreadId } from './ThreadId';

const connectionLabels: Record<ConnectionState, string> = {
  get connecting() {
    return t('errors:connecting');
  },
  get connected() {
    return t('errors:live_connection_healthy');
  },
  get disconnected() {
    return t('errors:disconnected');
  },
  get authenticationRequired() {
    return t('errors:login_required_again');
  },
};
export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  return (
    <span className={`connection-badge connection-${connection}`}>
      <span className="status-dot" />
      {connectionLabels[connection]}
    </span>
  );
}

export function Diagnostics({
  system,
  connection,
  operations,
  thread,
  selectedId,
  projectId,
  projects,
  threads,
  focusedOperationId,
  onOpenThread,
  threadReadFailed,
  onRefresh,
  onReconcile,
  onDiscardMissing,
  busy,
  open,
  onOpenChange,
  refreshing,
}: {
  system?: SystemInfo;
  connection: ConnectionState;
  operations: SavedOperation[];
  thread?: ThreadView;
  selectedId?: string;
  projectId: string;
  projects: Project[];
  threads: ThreadSummary[];
  focusedOperationId?: string;
  onOpenThread: (id: string, projectId?: string | null) => void;
  threadReadFailed: boolean;
  onRefresh: () => void;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  busy: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshing: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [metadata, setMetadata] = useState<
    Record<string, Pick<ThreadView, 'id' | 'title' | 'projectId' | 'status'>>
  >({});
  const ids = [
    ...new Set(operations.map(operationThreadId).filter((id): id is string => Boolean(id))),
  ].join(',');
  useEffect(() => {
    if (!open) return;
    let active = true;
    const missing = ids
      .split(',')
      .filter(
        (id) =>
          id && !metadata[id] && !threads.some((entry) => entry.id === id) && thread?.id !== id,
      );
    void Promise.allSettled(missing.map((id) => api.threadMetadata(id))).then((results) => {
      if (!active || !results.some((result) => result.status === 'fulfilled')) return;
      setMetadata((previous) => ({
        ...previous,
        ...Object.fromEntries(
          results.flatMap((result) =>
            result.status === 'fulfilled' ? [[result.value.id, result.value]] : [],
          ),
        ),
      }));
    });
    return () => {
      active = false;
    };
  }, [open, ids, threads, thread?.id, metadata]);
  useEffect(() => {
    if (!open || !focusedOperationId) return;
    const card = [
      ...(panel.current?.querySelectorAll<HTMLElement>('[data-operation-id]') ?? []),
    ].find((element) => element.dataset.operationId === focusedOperationId);
    card?.scrollIntoView({ block: 'nearest' });
    card?.focus({ preventScroll: true });
  }, [open, focusedOperationId]);
  const current = operations.filter(
    (entry) =>
      (Boolean(selectedId) && operationThreadId(entry) === selectedId) ||
      (!selectedId && entry.kind === 'create' && entry.target === projectId),
  );
  const other = operations.filter((entry) => !current.includes(entry));
  const renderCard = (entry: SavedOperation) => {
    const id = operationThreadId(entry);
    const owner =
      thread?.id === id
        ? thread
        : (threads.find((row) => row.id === id) ?? (id ? metadata[id] : undefined));
    const projectId = owner ? owner.projectId : (entry.context?.projectId ?? entry.projectId);
    const project = projects.find(
      (row) =>
        row.id === projectId ||
        (projectId === undefined && row.workspaceKey === entry.operation?.execution?.workspaceKey),
    );
    return (
      <OperationCard
        key={entry.clientOperationId}
        entry={entry}
        owner={owner}
        projectName={
          project?.name ??
          (projectId === null ? t('common:unassigned') : t('errors:recovery_project_unavailable'))
        }
        thread={thread}
        selectedId={selectedId}
        onOpenThread={onOpenThread}
        onReconcile={onReconcile}
        onDiscardMissing={onDiscardMissing}
        onRefresh={onRefresh}
        focused={entry.clientOperationId === focusedOperationId}
        busy={
          busy.includes(`reconcile:${entry.clientOperationId}`) ||
          busy.includes(`${entry.kind}:${entry.target}`)
        }
        refreshing={refreshing}
      />
    );
  };
  useEffect(() => {
    if (open && !focusedOperationId) panel.current?.focus();
  }, [open, focusedOperationId]);
  return (
    <details
      className="diagnostics"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>
        <Icon name="settings" size={16} />
        {t('common:diagnostics')}
        {operations.length > 0 && <span className="count-badge">{operations.length}</span>}
      </summary>
      <div
        className="diagnostics-panel"
        id="diagnostics-panel"
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label={t('errors:diagnostics_details')}
        aria-busy={refreshing}
      >
        <div className="diagnostics-heading">
          <h2>{t('errors:execution_status')}</h2>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            {refreshing ? t('common:checking') : t('errors:refresh_status')}
          </Button>
        </div>
        <section className="operation-section" aria-label={t('errors:current_session_information')}>
          <h3>{t('errors:current_session')}</h3>
          <div className="operation-owner">
            <span>
              {projects.find((project) => project.id === thread?.projectId)?.name ??
                (thread?.projectId === null ? t('common:unassigned') : '')}
            </span>
            <strong>
              {thread && thread.id === selectedId
                ? thread.title
                : selectedId
                  ? t('errors:loading_session_details')
                  : t('common:session_not_created_yet')}
            </strong>
          </div>
          <details className="raw-details">
            <summary>{t('common:technical_details')}</summary>
            <ThreadId
              id={thread?.id === selectedId ? thread?.id : undefined}
              placeholder={
                threadReadFailed ? t('errors:failed_to_load_session_details') : undefined
              }
            />
          </details>
        </section>
        <section className="operation-section">
          <h3>{t('errors:operations_and_reconciliation')}</h3>
          {(refreshing || current.length === 0) && (
            <p className="subtle" role="status">
              {refreshing
                ? t('errors:checking_session_history_and_submission_receipts')
                : thread?.status === 'unknown'
                  ? t('errors:session_state_still_needs_checking_inspect_operation_records')
                  : t('errors:no_submissions_need_checking')}
            </p>
          )}
          {current.map(renderCard)}
        </section>
        {other.length > 0 && (
          <section className="operation-section" aria-label={t('errors:recovery_other_threads')}>
            <h3>{t('errors:recovery_other_threads')}</h3>
            {other.map(renderCard)}
          </section>
        )}
        <dl>
          <dt>{t('errors:browser_connection')}</dt>
          <dd>{connectionLabels[connection]}</dd>
          <dt>Codex</dt>
          <dd>
            {system?.ready
              ? t('errors:ready')
              : system?.connection === 'starting'
                ? t('errors:starting')
                : t('errors:unavailable')}
          </dd>
          <dt>{t('errors:account_authentication')}</dt>
          <dd>
            {system?.authenticated === true
              ? t('errors:available')
              : system?.authenticated === false
                ? t('errors:log_in_to_codex_on_the_server_computer')
                : t('errors:unconfirmed')}
          </dd>
          <dt>{t('common:running_version')}</dt>
          <dd>{system?.codexVersion ?? t('common:not_detected')}</dd>
          <dt>{t('common:verified_version')}</dt>
          <dd>{system?.verifiedVersion ?? t('common:loading')}</dd>
          <dt>{t('errors:compatibility')}</dt>
          <dd>
            {system?.compatibility === 'verified'
              ? t('errors:version_verified')
              : system?.compatibility === 'unverified'
                ? system.compatibilityConfirmation === 'confirmed'
                  ? t('errors:version_unverified_continued_with_consent')
                  : t('errors:version_unverified_confirmation_pending')
                : t('errors:unavailable')}
          </dd>
          <dt>{t('errors:gateway_authentication')}</dt>
          <dd>
            {system?.authMode === 'cloudflare-access'
              ? 'Cloudflare Access'
              : t('errors:local_mode')}
          </dd>
        </dl>
        {system?.error && <p className="inline-error">{displayMessage(system.error)}</p>}
        {system && (
          <details className="raw-details">
            <summary>{t('errors:supported_capabilities')}</summary>
            <p>{system.capabilities.join(' · ') || t('errors:none')}</p>
          </details>
        )}
      </div>
    </details>
  );
}

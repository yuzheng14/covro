import { t } from '../i18n';
import { useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { RunStatus, ThreadSummary } from '../../shared/types';
import { threadOrigin } from '../lib/thread-origin';
import { formatTime, cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { ThreadId } from './ThreadId';
import { isActive, runStatusLabels, Status } from './Status';

const statusIcons = {
  running: 'loader',
  waitingApproval: 'shieldPending',
  waitingInput: 'chat',
  failed: 'alert',
  interrupted: 'stop',
  unknown: 'question',
} as const;

function ThreadStatusIcon({
  status,
  label,
  offline,
  pending,
}: {
  status: RunStatus;
  label: string;
  offline: boolean;
  pending: boolean;
}) {
  return (
    <ControlHint asChild content={label}>
      <span
        className={cn('thread-status-indicator', `thread-status-${status}`)}
        data-status={status}
        role="img"
        aria-label={label}
      >
        <span
          className={cn(
            'thread-status-glyph',
            status === 'running' && !offline && 'thread-status-spinning',
          )}
        >
          {status === 'idle' || status === 'completed' ? (
            <span className="thread-status-dot" />
          ) : (
            <Icon name={statusIcons[status]} size={15} />
          )}
        </span>
        {(pending || status === 'waitingApproval') && (
          <span className="thread-status-notification" />
        )}
      </span>
    </ControlHint>
  );
}

export function ThreadLink({
  thread,
  selected,
  unreadCompletion,
  offline,
  onSelect,
  onArchive,
  archiveDisabledReason,
  onFork,
  forkDisabledReason,
  forking,
}: {
  thread: ThreadSummary;
  selected: boolean;
  unreadCompletion: boolean;
  offline: boolean;
  onSelect: () => void;
  onArchive: () => void;
  archiveDisabledReason?: string;
  onFork: () => void;
  forkDisabledReason?: string;
  forking: boolean;
}) {
  const tooltipId = useId();
  const detailsId = useId();
  const forkHintId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const title = thread.title || t('sidebar:untitled_session');
  const origin = threadOrigin(thread);
  const archiveLabel = thread.archived ? t('common:unarchive') : t('sidebar:archive_session');
  const lastResult = thread.lastTurnStatus;
  const status =
    thread.status === 'idle' &&
    lastResult &&
    ['completed', 'failed', 'interrupted'].includes(lastResult)
      ? lastResult
      : thread.status;
  const statusLabel = `${offline && isActive(status) ? t('common:last_known') : ''}${runStatusLabels[status]}${
    status === 'completed' && unreadCompletion ? t('sidebar:unread') : ''
  }${thread.pendingActionCount > 0 ? t('sidebar:pending_requests_2', { count: thread.pendingActionCount, v0: thread.pendingActionCount }) : ''}`;
  const questionCount = thread.pendingQuestionCount ?? 0;
  const questionLabel = `${t('conversation:awaiting_answer')}${t('sidebar:pending_requests_2', {
    count: questionCount,
    v0: questionCount,
  })}`;
  const showStatus =
    (status !== 'idle' && status !== 'completed') ||
    unreadCompletion ||
    thread.pendingActionCount > 0;

  return (
    <div
      className="thread-row"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detailsOpen) {
          event.stopPropagation();
          setDetailsOpen(false);
          detailsButton.current?.focus();
        }
      }}
    >
      <ControlHint asChild content={title}>
        <button
          className={cn('thread-link', selected && 'thread-selected')}
          data-thread-id={thread.id}
          onClick={() => {
            setDetailsOpen(false);
            onSelect();
          }}
          aria-current={selected ? 'page' : undefined}
        >
          {thread.forkedFromId && <Icon name="fork" size={14} />}
          <span className="thread-link-content">
            <span className="thread-title">{title}</span>
            <span className="sr-only">
              {' · '}
              {statusLabel}
              {questionCount > 0 ? ` · ${questionLabel}` : ''}
            </span>
          </span>
        </button>
      </ControlHint>
      <div className="thread-row-actions">
        {questionCount > 0 && (
          <ThreadStatusIcon status="waitingInput" label={questionLabel} offline={offline} pending />
        )}
        {showStatus ? (
          <ThreadStatusIcon
            status={status === 'completed' && !unreadCompletion ? 'idle' : status}
            label={statusLabel}
            offline={offline}
            pending={thread.pendingActionCount > 0}
          />
        ) : (
          <span className="thread-status-placeholder" aria-hidden="true" />
        )}
        <ControlHint asChild content={t('sidebar:session_details_and_source')}>
          <Button
            ref={detailsButton}
            variant="ghost"
            size="icon"
            className="thread-details-trigger"
            aria-label={t('sidebar:session_details', { v0: title })}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <Icon name="info" size={15} />
          </Button>
        </ControlHint>
        <ControlHint
          id={forkHintId}
          className="thread-fork"
          content={
            forkDisabledReason ?? t('sidebar:fork_session_copy_saved_history_both_sessions_can')
          }
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={forking ? t('common:confirming_fork') : t('sidebar:fork_session')}
            aria-describedby={forkHintId}
            aria-busy={forking}
            disabled={Boolean(forkDisabledReason)}
            onClick={onFork}
          >
            {forking ? (
              <LoaderCircle size={15} className="thread-status-spinning" />
            ) : (
              <Icon name="fork" size={15} />
            )}
          </Button>
        </ControlHint>
        <ControlHint
          id={tooltipId}
          className="thread-archive"
          content={archiveDisabledReason ?? archiveLabel}
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={archiveLabel}
            aria-describedby={tooltipId}
            aria-disabled={Boolean(archiveDisabledReason)}
            onClick={() => {
              if (!archiveDisabledReason) onArchive();
            }}
          >
            <Icon name={thread.archived ? 'unarchive' : 'archive'} size={15} />
          </Button>
        </ControlHint>
      </div>
      <section
        id={detailsId}
        className="thread-details"
        data-testid="thread-details"
        hidden={!detailsOpen}
        aria-labelledby={`${detailsId}-title`}
      >
        <h3 id={`${detailsId}-title`}>{title}</h3>
        <dl>
          <div className="thread-id-row">
            <dt>Thread ID</dt>
            <dd>
              <ThreadId id={thread.id} />
            </dd>
          </div>
          <div>
            <dt>{t('sidebar:created_from')}</dt>
            <dd>{origin.label}</dd>
          </div>
          {thread.updatedAt !== undefined && (
            <div>
              <dt>{t('sidebar:updated_at')}</dt>
              <dd>{formatTime(thread.updatedAt)}</dd>
            </div>
          )}
          <div>
            <dt>{t('sidebar:task_status')}</dt>
            <dd>
              <Status status={status} offline={offline} />
            </dd>
          </div>
          {status === 'completed' && thread.lastTurnId && (
            <div>
              <dt>{t('sidebar:read_status')}</dt>
              <dd>{unreadCompletion ? t('sidebar:unread_2') : t('sidebar:read')}</dd>
            </div>
          )}
          {thread.pendingActionCount > 0 && (
            <div>
              <dt>{t('sidebar:pending')}</dt>
              <dd>
                {t('sidebar:pending_requests', {
                  count: thread.pendingActionCount,
                  v0: thread.pendingActionCount,
                })}
              </dd>
            </div>
          )}
          {questionCount > 0 && (
            <div>
              <dt>{t('conversation:awaiting_answer')}</dt>
              <dd>{t('sidebar:pending_requests', { count: questionCount, v0: questionCount })}</dd>
            </div>
          )}
          {thread.forkedFromId && (
            <div>
              <dt>{t('sidebar:session_type')}</dt>
              <dd>{t('sidebar:forked_session')}</dd>
            </div>
          )}
        </dl>
        <p>{origin.description}</p>
        <p className="thread-origin-note">
          {t('sidebar:source_records_the_client_used_at_creation_not')}
        </p>
        {archiveDisabledReason && <p>{archiveDisabledReason}</p>}
      </section>
    </div>
  );
}

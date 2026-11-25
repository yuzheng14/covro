import type { SessionLoopTask } from '../../shared/session-loop';
import { useSessionLoops, type RunLoopOperation } from '../hooks/useSessionLoops';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { Icon } from './Icon';
import { SessionLoopRow } from './SessionLoopRow';

export function LoopTasks({
  run,
  controlsDisabled,
  onOpenThread,
}: {
  run: RunLoopOperation;
  controlsDisabled: (id: string) => boolean;
  onOpenThread: (task: SessionLoopTask) => void;
}) {
  const {
    loops,
    error,
    controlsDisabled: refreshing,
    control,
  } = useSessionLoops<SessionLoopTask>('/api/loop-tasks', run);
  return (
    <>
      {error && (
        <p role="alert" className="inline-error">
          {displayMessage(error)}
        </p>
      )}
      {!error && !loops && (
        <p className="subtle" role="status">
          {t('common:loading_2')}
        </p>
      )}
      {loops?.length === 0 && <p className="subtle">{t('sidebar:loop_tasks_empty')}</p>}
      <div className="session-loop-list" aria-live="polite">
        {loops?.map((loop) => (
          <SessionLoopRow
            key={loop.id}
            loop={loop}
            archived={loop.archived}
            waiting={loop.waiting}
            disabled={refreshing || controlsDisabled(loop.threadId)}
            onControl={(action) => void control(loop, action)}
            heading={
              <button
                className="background-task-row loop-task-link"
                onClick={() => onOpenThread(loop)}
              >
                <span>
                  <strong className="session-loop-prompt">{loop.prompt}</strong>
                  <span>
                    {loop.projectName ?? t('common:unassigned')} · {loop.threadTitle}
                  </span>
                </span>
                <Icon name="chevron" size={14} />
              </button>
            }
          />
        ))}
      </div>
    </>
  );
}

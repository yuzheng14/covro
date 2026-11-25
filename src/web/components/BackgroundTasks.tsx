import { useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import type { SessionLoopTask } from '../../shared/session-loop';
import type { RunLoopOperation } from '../hooks/useSessionLoops';
import type { BackgroundTaskState } from '../hooks/useBackgroundTasks';
import { cloneProgress, cloneRunning, cloneProgressLabel } from '../lib/project-clone-labels';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { CommandDialog } from './CommandDialog';
import { LoopTasks } from './LoopTasks';
import './background-tasks.css';

export function BackgroundTasks({
  tasks,
  onDetails,
  runLoop,
  loopControlsDisabled,
  onOpenLoopThread,
}: {
  tasks: BackgroundTaskState;
  onDetails: (id: string) => void;
  runLoop: RunLoopOperation;
  loopControlsDisabled: (id: string) => boolean;
  onOpenLoopThread: (task: SessionLoopTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'clones' | 'loops'>('clones');
  const running = tasks.jobs.filter(cloneRunning).length;
  const details = (id: string) => {
    setOpen(false);
    tasks.dismiss();
    onDetails(id);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('sidebar:background_tasks')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          tasks.refresh();
          setSection('clones');
          setOpen(true);
        }}
      >
        <Icon name={running ? 'loader' : 'archive'} size={16} />
        <span>{t('sidebar:tasks')}</span>
        {running > 0 && <span className="background-task-count">{running}</span>}
      </Button>
      <CommandDialog
        portal
        open={open}
        title={t('sidebar:background_tasks')}
        onClose={() => setOpen(false)}
      >
        <div className="background-task-sections" role="group" aria-label={t('sidebar:tasks')}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={section === 'clones'}
            onClick={() => setSection('clones')}
          >
            {t('sidebar:clone_tasks')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={section === 'loops'}
            onClick={() => setSection('loops')}
          >
            {t('sidebar:loop_tasks')}
          </Button>
        </div>
        {open && section === 'loops' ? (
          <LoopTasks
            run={runLoop}
            controlsDisabled={loopControlsDisabled}
            onOpenThread={(task) => {
              setOpen(false);
              onOpenLoopThread(task);
            }}
          />
        ) : (
          <>
            {tasks.error && (
              <p role="alert" className="inline-error">
                {t('sidebar:tasks_connection_lost')}
              </p>
            )}
            {!tasks.jobs.length && <p className="subtle">{t('sidebar:tasks_empty')}</p>}
            <ul className="background-task-list">
              {tasks.jobs.map((job) => (
                <li key={job.id}>
                  <button className="background-task-row" onClick={() => details(job.id)}>
                    <Icon
                      name={
                        cloneRunning(job)
                          ? 'loader'
                          : job.status === 'completed'
                            ? 'check'
                            : 'alert'
                      }
                      size={18}
                    />
                    <span>
                      <strong>{job.name || job.path.split(/[/\\]/).filter(Boolean).at(-1)}</strong>
                      <span>{cloneProgressLabel(job)}</span>
                      <code>{job.path}</code>
                    </span>
                    <Icon name="chevron" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </CommandDialog>
      {tasks.notice &&
        createPortal(
          <div className="background-task-notice" role="status" aria-live="polite">
            <span>
              {tasks.notice.name || t('sidebar:import_clone')} · {cloneProgress(tasks.notice)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => details(tasks.notice!.id)}>
              {t('sidebar:tasks_view')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common:close')}
              onClick={tasks.dismiss}
            >
              <Icon name="close" size={14} />
            </Button>
          </div>,
          document.body,
        )}
    </>
  );
}

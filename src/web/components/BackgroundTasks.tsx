import { useState } from 'react';
import { t } from '../i18n';
import type { BackgroundTaskState } from '../hooks/useBackgroundTasks';
import { cloneProgress, cloneRunning, cloneProgressLabel } from '../lib/project-clone-labels';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { CommandDialog } from './CommandDialog';
import './background-tasks.css';

export function BackgroundTasks({
  tasks,
  onDetails,
}: {
  tasks: BackgroundTaskState;
  onDetails: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
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
          setOpen(true);
        }}
      >
        <Icon name={running ? 'loader' : 'archive'} size={16} />
        <span>{t('sidebar:tasks')}</span>
        {running > 0 && <span className="background-task-count">{running}</span>}
      </Button>
      <CommandDialog
        open={open}
        title={t('sidebar:background_tasks')}
        onClose={() => setOpen(false)}
      >
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
                    cloneRunning(job) ? 'loader' : job.status === 'completed' ? 'check' : 'alert'
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
      </CommandDialog>
      {tasks.notice && (
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
        </div>
      )}
    </>
  );
}

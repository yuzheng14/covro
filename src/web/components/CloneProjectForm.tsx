import { t } from '../i18n';
import { displayMessage, messageDetails } from '../i18n/messages';
import { errorMessage } from '../lib/error-message';
import { cloneRunning as running, cloneProgressLabel } from '../lib/project-clone-labels';
import { useEffect, useRef, useState } from 'react';
import { api, HttpError } from '../lib/api';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { useProjectPath } from '../hooks/useProjectPath';
import { ProjectPathPreview } from './ProjectPathPreview';

export function CloneProjectForm(props: {
  disabled: boolean;
  cloneId?: string;
  tasks: import('../hooks/useBackgroundTasks').BackgroundTaskState;
  onBusyChange: (busy: boolean) => void;
  onImported: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [repository, setRepository] = useState('');
  const [name, setName] = useState('');
  const [jobId, setJobId] = useState(props.cloneId);
  const job = props.tasks.jobs.find((entry) => entry.id === jobId);
  const path = useProjectPath(!job && !jobId, repository);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [missing, setMissing] = useState(false);
  const submitting = useRef(false);
  const busy = sending;
  const { onBusyChange } = props;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (job) {
      path.setValue(job.path);
      setName(job.name ?? '');
      setError(undefined);
      setMissing(false);
    }
  }, [job, path.setValue]);

  const { accept } = props.tasks;
  useEffect(() => {
    if (!jobId || job) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = async () => {
      try {
        const recovered = await api.projectClone(jobId);
        if (!stopped) accept(recovered);
      } catch (problem) {
        if (stopped) return;
        setError(readableError(problem));
        if (problem instanceof HttpError && problem.status === 404) setMissing(true);
        else timer = setTimeout(() => void reconcile(), 1000);
      }
    };
    void reconcile();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, job, accept]);

  async function start() {
    if (jobId || busy || props.disabled || submitting.current || !path.ready) return;
    submitting.current = true;
    setSending(true);
    setError(undefined);
    const id = crypto.randomUUID();

    try {
      const next = await api.cloneProject({
        clientOperationId: id,
        repository: repository.trim(),
        path: path.path!,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      props.tasks.accept(next);
      setJobId(id);
      props.tasks.refresh();
    } catch (problem) {
      setError(readableError(problem));
      if (!(problem instanceof HttpError) || problem.status >= 500) {
        // Reconcile a lost POST via server history; never repeat the submission.
        setJobId(id);
        props.tasks.refresh();
      }
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  async function action(kind: 'cancel' | 'register' | 'open') {
    if (!job || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError(undefined);
    try {
      if (kind === 'open' && job.project) {
        await props.onImported(job.project.id);
        props.onClose();
      } else {
        props.tasks.accept(
          await (kind === 'cancel'
            ? api.cancelProjectClone(job.id)
            : api.registerProjectClone(job.id)),
        );
      }
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      submitting.current = false;
      setSending(false);
      props.tasks.refresh();
    }
  }

  const terminal = (job && !running(job)) || missing;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <p id="project-dialog-description" className={jobId ? 'sr-only' : undefined}>
        {t('sidebar:clone_intro')}
      </p>
      {!job && !jobId && (
        <>
          <label className="project-field">
            <span>{t('sidebar:clone_repository')}</span>
            <input
              autoFocus
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/owner/repository.git"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              disabled={props.disabled || sending}
              aria-describedby="clone-auth-help"
              aria-label={t('sidebar:clone_repository')}
            />
            <small id="clone-auth-help">{t('sidebar:clone_auth_help')}</small>
          </label>
          <label className="project-field">
            <span>{t('sidebar:clone_target')}</span>
            <input
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/you/code/my-project"
              value={path.value}
              onChange={(event) => path.setValue(event.target.value)}
              disabled={props.disabled || sending}
              aria-describedby="clone-path-help"
              aria-label={t('sidebar:clone_target')}
            />
            <small id="clone-path-help">{t('sidebar:work_dir_clone_help')}</small>
          </label>
          <ProjectPathPreview value={path} />
          <label className="project-field">
            <span>{t('sidebar:project_name_optional')}</span>
            <input
              maxLength={100}
              placeholder={t('sidebar:defaults_to_directory_name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={props.disabled || sending}
            />
          </label>
        </>
      )}
      {(job || (jobId && !missing)) && (
        <div className="project-clone-status" role="status" aria-live="polite">
          <strong>{job ? cloneProgressLabel(job) : t('sidebar:clone_checking')}</strong>
          {running(job) && (
            <progress aria-label={t('sidebar:clone_progress')} max={100} value={job?.percent} />
          )}
          <code>{job?.path ?? path.path ?? path.value}</code>
        </div>
      )}
      {jobId && !job && <p className="subtle">{t('sidebar:tasks_checking')}</p>}
      {props.tasks.error && jobId && (
        <p role="alert" className="inline-error">
          {t('sidebar:tasks_connection_lost')}
        </p>
      )}
      {job?.error && (
        <p className="inline-error project-dialog-error" role="alert">
          {displayMessage(
            errorMessage({ code: job.errorCode ?? 'CLONE_FAILED', message: job.error }),
          )}
        </p>
      )}
      {error && (
        <p className="inline-error project-dialog-error" role="alert">
          {displayMessage(error)}
        </p>
      )}
      {(job?.error || messageDetails(error)) && (
        <details className="project-clone-details">
          <summary>{t('common:technical_details')}</summary>
          <pre>{job?.error ?? messageDetails(error)}</pre>
        </details>
      )}
      {props.disabled && (
        <p className="subtle">{t('sidebar:your_login_expired_log_in_again_to_manage')}</p>
      )}
      <div className="project-dialog-actions">
        {jobId && (
          <Button variant="secondary" disabled={sending} onClick={props.onClose}>
            {running(job) || !job ? t('sidebar:clone_background') : t('common:close')}
          </Button>
        )}
        {running(job) ? (
          <Button
            variant="secondary"
            disabled={props.disabled || sending || job?.status === 'cancelling'}
            onClick={() => void action('cancel')}
          >
            {job?.status === 'cancelling'
              ? t('sidebar:clone_cancelling')
              : t('sidebar:clone_cancel')}
          </Button>
        ) : !jobId ? (
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {t('common:close')}
          </Button>
        ) : null}
        {job?.status === 'completed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('open')}>
            {t('sidebar:clone_open')}
          </Button>
        ) : job?.status === 'registration-failed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('register')}>
            {t('sidebar:clone_register_retry')}
          </Button>
        ) : terminal ? (
          <Button
            disabled={props.disabled || sending}
            onClick={(event) => {
              event.preventDefault();
              setJobId(undefined);
              setError(undefined);
              setMissing(false);
            }}
          >
            {t('sidebar:clone_empty_retry')}
          </Button>
        ) : (
          !jobId && (
            <Button
              type="submit"
              disabled={props.disabled || sending || !repository.trim() || !path.ready}
            >
              {sending ? t('common:submitting') : t('sidebar:clone_start')}
            </Button>
          )
        )}
      </div>
    </form>
  );
}

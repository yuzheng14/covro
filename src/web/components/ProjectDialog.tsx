import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { CloneProjectForm } from './CloneProjectForm';
import { useProjectPath } from '../hooks/useProjectPath';
import { ProjectPathPreview } from './ProjectPathPreview';

interface Props {
  project?: Project;
  cloneId?: string;
  tasks: import('../hooks/useBackgroundTasks').BackgroundTaskState;
  disabled: boolean;
  onAdd: (input: { path: string; name?: string }) => Promise<void>;
  onImported: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

export function ProjectDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState(props.project?.name ?? '');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cloneMode, setCloneMode] = useState(Boolean(props.cloneId));
  const path = useProjectPath(!props.project && !cloneMode);
  const [error, setError] = useState<string>();
  const disabled = props.disabled || busy;
  const title = removing
    ? t('sidebar:remove_project_2')
    : props.project
      ? t('common:manage_project')
      : t('sidebar:add_server_project');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function submit() {
    if (disabled || submitting.current || (!props.project && !path.ready)) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (props.project) {
        if (removing) await props.onRemove(props.project.id);
        else await props.onRename(props.project.id, name.trim());
      } else {
        await props.onAdd({ path: path.path!, ...(name.trim() ? { name: name.trim() } : {}) });
      }
      props.onClose();
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="project-dialog-title"
      aria-describedby="project-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy || cloneMode) props.onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Icon name="folder" size={20} />
          <h2 id="project-dialog-title">{title}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('sidebar:close_project_management')}
          disabled={busy && !cloneMode}
          onClick={props.onClose}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      {!props.project && !props.cloneId && (
        <div className="project-import-modes" role="group" aria-label={t('sidebar:import_source')}>
          <Button
            variant={cloneMode ? 'ghost' : 'secondary'}
            disabled={busy}
            aria-pressed={!cloneMode}
            onClick={() => setCloneMode(false)}
          >
            {t('sidebar:import_existing')}
          </Button>
          <Button
            variant={cloneMode ? 'secondary' : 'ghost'}
            disabled={busy}
            aria-pressed={cloneMode}
            onClick={() => setCloneMode(true)}
          >
            {t('sidebar:import_clone')}
          </Button>
        </div>
      )}
      {cloneMode ? (
        <CloneProjectForm
          disabled={props.disabled}
          cloneId={props.cloneId}
          tasks={props.tasks}
          onBusyChange={setBusy}
          onImported={props.onImported}
          onClose={props.onClose}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {removing ? (
            <>
              <p id="project-dialog-description">
                {t('sidebar:remove_from_this_workspace', { v0: props.project?.name })}
              </p>
              <div className="project-removal-note">
                <p>{t('sidebar:only_the_project_list_entry_is_removed_server')}</p>
                <p>{t('sidebar:add_the_same_directory_later_to_access_its')}</p>
              </div>
            </>
          ) : (
            <>
              <p id="project-dialog-description">
                {props.project
                  ? t('sidebar:set_a_recognizable_project_name_or_remove_it')
                  : t('sidebar:add_an_existing_directory_on_the_server_running')}
              </p>
              {props.project ? (
                <div className="project-directory">
                  <span>{t('sidebar:server_directory')}</span>
                  <code>{props.project.rootPath}</code>
                </div>
              ) : (
                <label className="project-field">
                  <span>{t('sidebar:server_directory')}</span>
                  <input
                    autoFocus
                    required
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="/home/you/code/my-project"
                    value={path.value}
                    onChange={(event) => path.setValue(event.target.value)}
                    aria-describedby="project-path-help"
                    aria-label={t('sidebar:server_directory')}
                    disabled={disabled}
                  />
                  <small id="project-path-help">{t('sidebar:work_dir_path_help')}</small>
                </label>
              )}
              {!props.project && <ProjectPathPreview value={path} />}
              <label className="project-field">
                <span>
                  {props.project ? t('sidebar:project_name') : t('sidebar:project_name_optional')}
                </span>
                <input
                  autoFocus={Boolean(props.project)}
                  required={Boolean(props.project)}
                  maxLength={100}
                  placeholder={t('sidebar:defaults_to_directory_name')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={disabled}
                />
              </label>
            </>
          )}
          {error && (
            <p className="inline-error project-dialog-error" role="alert">
              {displayMessage(error)}
            </p>
          )}
          {props.disabled && (
            <p className="subtle">{t('sidebar:your_login_expired_log_in_again_to_manage')}</p>
          )}
          <div className="project-dialog-actions">
            {props.project && !removing && (
              <Button
                className="project-remove-button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setError(undefined);
                  setRemoving(true);
                }}
              >
                {t('sidebar:remove_project')}
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (removing) {
                  setError(undefined);
                  setRemoving(false);
                } else props.onClose();
              }}
            >
              {removing ? t('sidebar:back') : t('common:cancel')}
            </Button>
            <Button
              type="submit"
              variant={removing ? 'destructive' : 'default'}
              disabled={disabled || (!removing && (props.project ? !name.trim() : !path.ready))}
            >
              {busy
                ? removing
                  ? t('sidebar:removing')
                  : t('common:saving')
                : removing
                  ? t('sidebar:confirm_removal')
                  : props.project
                    ? t('sidebar:save_name')
                    : t('common:add_project')}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

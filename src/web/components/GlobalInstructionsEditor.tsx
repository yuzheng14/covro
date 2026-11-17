import { SettingsSurface, useSettingsLeaveGuard } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import type { GlobalInstructions } from '../../shared/global-instructions';
import { api } from '../lib/api';
import { readableError } from '../lib/utils';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function GlobalInstructionsEditor({
  disabled,
  onClose,
}: {
  disabled: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<GlobalInstructions>();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState<'close' | 'reload'>();
  const dirty = snapshot !== undefined && snapshot.content !== content;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    void api
      .globalInstructions(controller.signal)
      .then((value) => {
        setSnapshot(value);
        setContent(value.content);
      })
      .catch((problem: unknown) => {
        if (!controller.signal.aborted) setError(readableError(problem));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      element?.close();
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  function close() {
    if (busy.current) return;
    if (dirty) setDiscard('close');
    else onClose();
  }
  async function reload() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    setSaved(false);
    try {
      const value = await api.globalInstructions();
      setSnapshot(value);
      setContent(value.content);
      setDiscard(undefined);
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }
  async function save() {
    if (!snapshot || snapshot.overridden || disabled || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const value = await api.saveGlobalInstructions({
        content,
        revision: snapshot.revision,
      });
      setSnapshot(value);
      setSaved(true);
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }
  useSettingsLeaveGuard(close);
  return (
    <SettingsSurface
      ref={dialog}
      className="project-dialog instructions-dialog"
      aria-labelledby="instructions-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <h2 id="instructions-title">{t('sidebar:instructions_title')}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:close')}
          disabled={saving || loading}
          onClick={close}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="subtle">{t('sidebar:instructions_description')}</p>
      {loading && <p role="status">{t('common:loading_2')}</p>}
      {snapshot && (
        <>
          <code className="instructions-path">{snapshot.path}</code>
          {snapshot.overridden && (
            <p role="alert" className="inline-error">
              {t('sidebar:instructions_override')}
            </p>
          )}
          {!snapshot.exists && <p className="subtle">{t('sidebar:instructions_missing')}</p>}
          <label className="instructions-label" htmlFor="instructions-content">
            AGENTS.md
          </label>
          <textarea
            id="instructions-content"
            className="instructions-content mono"
            value={content}
            spellCheck={false}
            disabled={disabled || loading || saving || snapshot.overridden}
            onChange={(event) => {
              setContent(event.target.value);
              setSaved(false);
              setDiscard(undefined);
            }}
          />
          {dirty && <p className="subtle">{t('sidebar:instructions_unsaved')}</p>}
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {displayMessage(error)}
        </p>
      )}
      {saved && <p role="status">{t('sidebar:instructions_saved')}</p>}
      {discard && (
        <div className="instructions-discard" role="alert">
          <p>{t('sidebar:instructions_discard')}</p>
          <Button variant="secondary" onClick={() => setDiscard(undefined)}>
            {t('sidebar:instructions_keep')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (discard === 'close') onClose();
              else void reload();
            }}
          >
            {t('sidebar:instructions_discard_confirm')}
          </Button>
        </div>
      )}
      <div className="project-dialog-actions">
        <Button
          variant="secondary"
          disabled={loading || saving}
          onClick={() => {
            if (dirty) setDiscard('reload');
            else void reload();
          }}
        >
          {t('sidebar:instructions_reload')}
        </Button>
        <Button
          disabled={
            disabled ||
            loading ||
            saving ||
            !snapshot ||
            snapshot.overridden ||
            (snapshot.exists && !dirty)
          }
          onClick={() => void save()}
        >
          {t(saving ? 'sidebar:instructions_saving' : 'sidebar:instructions_save')}
        </Button>
      </div>
    </SettingsSurface>
  );
}

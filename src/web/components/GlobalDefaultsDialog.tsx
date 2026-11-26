import { SettingsSurface, useSettingsLeaveGuard } from './SettingsSurface';
import { useEffect, useRef, useState } from 'react';
import type { GlobalDefaultsSnapshot, GlobalDefaultSettings } from '../../shared/global-defaults';
import { api, HttpError } from '../lib/api';
import { readableError } from '../lib/utils';
import { permissionModeUnavailable } from '../lib/permissions';
import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { PermissionModeSelect } from './PermissionModeSelect';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
const automatic = '__codex_default__';
function notifyDefaultsChanged() {
  window.dispatchEvent(new Event('covro:defaults-updated'));
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('covro-defaults');
    channel.postMessage('updated');
    channel.close();
  }
}
export function GlobalDefaultsDialog({
  disabled,
  onClose,
}: {
  disabled: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [snapshot, setSnapshot] = useState<GlobalDefaultsSnapshot>();
  const [draft, setDraft] = useState<GlobalDefaultSettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = Boolean(
    snapshot && draft && JSON.stringify(snapshot.settings) !== JSON.stringify(draft),
  );
  const model = snapshot?.models.find((value) => value.id === draft?.model);
  const unavailable = draft?.permissionMode
    ? permissionModeUnavailable(draft.permissionMode, snapshot?.capabilities, draft.model)
    : undefined;
  const invalidEffort =
    draft?.reasoningEffort != null && !model?.reasoningEfforts.includes(draft.reasoningEffort);
  function accept(value: GlobalDefaultsSnapshot) {
    setSnapshot(value);
    setDraft(value.settings);
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    void api
      .globalDefaults(controller.signal)
      .then(accept)
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
  const close = () => {
    if (busy.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  async function reload() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    setStatus(undefined);
    try {
      accept(await api.globalDefaults());
      setUncertain(false);
      setReloadRequired(false);
      notifyDefaultsChanged();
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }
  async function save() {
    if (
      !snapshot ||
      !draft ||
      busy.current ||
      disabled ||
      unavailable ||
      invalidEffort ||
      reloadRequired
    )
      return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await api.saveGlobalDefaults({ version: snapshot.version, settings: draft });
      accept(await api.globalDefaults());
      setUncertain(false);
      setReloadRequired(false);
      setStatus(
        t(
          result.status === 'okOverridden'
            ? 'settings:global_defaults_overridden'
            : 'settings:global_defaults_saved',
        ),
      );
      notifyDefaultsChanged();
    } catch (problem) {
      setError(readableError(problem));
      setReloadRequired(true);
      const details = problem instanceof HttpError ? problem.problem.details : undefined;
      const reportedUncertain =
        typeof details === 'object' && details !== null && 'uncertain' in details
          ? details.uncertain
          : undefined;
      const definiteFailure =
        problem instanceof HttpError &&
        (reportedUncertain === false || (reportedUncertain !== true && problem.status < 500));
      setUncertain(!definiteFailure);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  function change(value: Partial<GlobalDefaultSettings>) {
    if (draft) setDraft({ ...draft, ...value });
    setStatus(undefined);
    setDiscard(false);
  }
  useSettingsLeaveGuard(close);
  return (
    <SettingsSurface
      ref={dialog}
      className="project-dialog global-defaults-dialog"
      aria-labelledby="global-defaults-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <h2 id="global-defaults-title">{t('settings:global_defaults_title')}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:close')}
          disabled={saving}
          onClick={close}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="subtle">{t('settings:global_defaults_description')}</p>
      {loading && <p role="status">{t('common:loading_2')}</p>}
      {snapshot && draft && (
        <fieldset className="global-defaults-fields" disabled={disabled || loading || saving}>
          <label className="project-field">
            <span>{t('settings:global_default_model')}</span>
            <Select
              value={draft.model ?? automatic}
              onValueChange={(value) => {
                const selected = snapshot.models.find((item) => item.id === value);
                change({
                  model: value === automatic ? null : value,
                  reasoningEffort:
                    draft.reasoningEffort &&
                    selected?.reasoningEfforts.includes(draft.reasoningEffort)
                      ? draft.reasoningEffort
                      : null,
                });
              }}
            >
              <SelectTrigger aria-label={t('settings:global_default_model')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={automatic}>{t('settings:global_defaults_automatic')}</SelectItem>
                {draft.model && !model && (
                  <SelectItem value={draft.model} disabled>
                    {draft.model}
                  </SelectItem>
                )}
                {snapshot.models.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="project-field">
            <span>{t('settings:global_default_effort')}</span>
            <Select
              value={draft.reasoningEffort ?? automatic}
              onValueChange={(value) =>
                change({ reasoningEffort: value === automatic ? null : value })
              }
            >
              <SelectTrigger aria-label={t('settings:global_default_effort')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={automatic}>
                  {t('settings:global_defaults_model_effort')}
                </SelectItem>
                {invalidEffort && draft.reasoningEffort && (
                  <SelectItem value={draft.reasoningEffort} disabled>
                    {draft.reasoningEffort}
                  </SelectItem>
                )}
                {model?.reasoningEfforts.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="project-field">
            <span>{t('settings:global_default_permission')}</span>
            <PermissionModeSelect
              value={draft.permissionMode ?? automatic}
              label={t('settings:global_default_permission')}
              capabilities={snapshot.capabilities}
              model={draft.model}
              disabled={disabled || loading || saving}
              extraOptions={[
                {
                  value: automatic,
                  label: t('settings:global_defaults_keep_permission'),
                  icon: 'settings',
                },
              ]}
              onChange={(value) => change({ permissionMode: value === automatic ? null : value })}
            />
          </label>
        </fieldset>
      )}
      {unavailable && <p className="inline-error">{unavailable}</p>}
      {invalidEffort && (
        <p className="inline-error">{t('settings:global_defaults_invalid_effort')}</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {displayMessage(error)}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {uncertain && <p className="subtle">{t('settings:global_defaults_uncertain')}</p>}
      {discard && (
        <div className="global-defaults-discard" role="alert">
          <p>{t('settings:global_defaults_discard')}</p>
          <Button variant="secondary" onClick={() => setDiscard(false)}>
            {t('settings:global_defaults_continue')}
          </Button>
          <Button variant="destructive" onClick={onClose}>
            {t('settings:global_defaults_discard_confirm')}
          </Button>
        </div>
      )}
      <div className="project-dialog-actions">
        <Button
          variant="secondary"
          disabled={saving || loading || (dirty && !reloadRequired)}
          onClick={() => void reload()}
        >
          {t('settings:global_defaults_reload')}
        </Button>
        <Button
          disabled={
            disabled ||
            loading ||
            saving ||
            !dirty ||
            !snapshot ||
            Boolean(unavailable) ||
            invalidEffort ||
            reloadRequired
          }
          onClick={() => void save()}
        >
          {t(saving ? 'settings:global_defaults_saving' : 'settings:global_defaults_save')}
        </Button>
      </div>
    </SettingsSurface>
  );
}

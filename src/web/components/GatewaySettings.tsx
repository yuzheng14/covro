import { errorMessage } from '../lib/error-message';
import { message, displayMessage, messageDetails } from '../i18n/messages';
import { t, formatList } from '../i18n';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, Upload, Settings2 } from 'lucide-react';
import type {
  GatewayConfig,
  GatewayConfigImport,
  GatewayConfigSnapshot,
} from '../../shared/gateway-config';
import { api, HttpError } from '../lib/api';
import {
  configChanges,
  configFields,
  configFieldValue,
  configFormErrors,
  configForm,
  formConfig,
  type ConfigField,
  type ConfigForm,
  type ConfigFormErrors,
} from '../lib/gateway-config';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Icon } from './Icon';
import { ServiceRestartControl } from './ServiceRestart';
import type { ServiceRestart } from '../hooks/useServiceRestart';

const describeFailure = (error: unknown) =>
  error instanceof HttpError
    ? errorMessage(error.problem)
    : error instanceof Error
      ? error.message
      : t('settings:operation_failed_please_retry');

export function GatewaySettings({
  onClose: onDismiss,
  restart,
  connected = false,
}: {
  onClose: () => void;
  restart?: ServiceRestart;
  connected?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onClose = () => {
    dialog.current?.close();
    onDismiss();
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<GatewayConfigSnapshot>();
  const [form, setForm] = useState<ConfigForm>();
  const [review, setReview] = useState<GatewayConfig>();
  const [imported, setImported] = useState<GatewayConfigImport>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ConfigFormErrors>({});
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty =
    !!snapshot &&
    !!form &&
    JSON.stringify(formConfig(form, snapshot.saved)) !== JSON.stringify(snapshot.saved);

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void api
      .gatewayConfig()
      .then((next) => {
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setForm(configForm(next.saved));
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeFailure(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      dialog.current?.close();
    };
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const close = () => {
    if (busy) return;
    if (dirty || imported) setConfirmClose(true);
    else onClose();
  };
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(describeFailure(failure));
      if (failure instanceof HttpError && failure.problem.code === 'CONFIG_CONFLICT')
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    await run(async () => {
      const next = await api.gatewayConfig();
      setSnapshot(next);
      setForm(configForm(next.saved));
      setFieldErrors({});
      setReview(undefined);
      setImported(undefined);
      setConflict(false);
    });
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await run(async () => {
      if (file.size > 256 * 1024)
        throw new Error(t('settings:configuration_files_cannot_exceed_256_kib'));
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new Error(t('settings:cannot_parse_json_check_the_file_format'));
      }
      setImported(await api.importGatewayConfig(value));
      setReview(undefined);
    });
  }
  async function exportFile() {
    await run(async () => {
      const saved = await api.exportGatewayConfig();
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(saved, null, 2)}\n`], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'codex-web-config.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(message('settings:exported_saved_configuration_from_the_file_unsaved_edits'));
    });
  }
  const running = snapshot && configForm(snapshot.running);
  const preview = imported?.config ?? review;
  const changes = snapshot && preview ? configChanges(snapshot.saved, preview) : [];
  function field(item: ConfigField) {
    if (!form || !running) return null;
    if (['issuer', 'audience'].includes(item.key) && form.mode !== 'cloudflare-access') return null;
    const props = {
      id: `gateway-${item.key}`,
      'aria-labelledby': `gateway-${item.key}-label`,
      'aria-describedby': `gateway-${item.key}-help${fieldErrors[item.key] ? ` gateway-${item.key}-error` : ''}`,
      'aria-invalid': !!fieldErrors[item.key],
      value: form[item.key],
      disabled: busy || !snapshot?.writable,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setForm({ ...form, [item.key]: event.target.value });
        setFieldErrors((previous) => ({ ...previous, [item.key]: undefined }));
        setNotice('');
      },
    };
    return (
      <label className="project-field" key={item.key} htmlFor={props.id}>
        <span id={`gateway-${item.key}-label`}>{item.label}</span>
        {'multiline' in item ? (
          <textarea {...props} rows={3} spellCheck={false} />
        ) : (
          <input
            {...props}
            type={'type' in item ? item.type : 'text'}
            inputMode={'unit' in item ? 'decimal' : undefined}
            spellCheck={false}
          />
        )}
        <small id={`gateway-${item.key}-help`}>{item.help}</small>
        {fieldErrors[item.key] && (
          <small id={`gateway-${item.key}-error`} className="gateway-error" role="alert">
            {fieldErrors[item.key]}
          </small>
        )}
        {form[item.key] !== running[item.key] && (
          <small className="gateway-running">
            {t('settings:currently_running', {
              v0: configFieldValue(item, running[item.key]) || t('settings:not_set'),
            })}
          </small>
        )}
      </label>
    );
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog gateway-dialog"
      aria-labelledby="gateway-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Settings2 size={20} aria-hidden="true" />
          <h2 id="gateway-title">{t('common:service_settings')}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('settings:close_service_settings')}
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      {restart && (
        <ServiceRestartControl
          restart={restart}
          connected={connected}
          editing={busy || dirty || !!review || !!imported}
        />
      )}
      <p className="gateway-intro">{t('settings:service_settings_apply_help')}</p>
      {error && (
        <div className="gateway-error" role="alert">
          <p>{displayMessage(error)}</p>
          {messageDetails(error) && (
            <details>
              <summary>{t('common:technical_details')}</summary>
              <pre>{messageDetails(error)}</pre>
            </details>
          )}
        </div>
      )}
      {!snapshot && (
        <Button variant="secondary" disabled={busy} onClick={() => void reload()}>
          {busy ? t('settings:loading_configuration') : t('settings:reload_configuration')}
        </Button>
      )}
      {snapshot && form && (
        <>
          <div className="gateway-file">
            <span>{t('settings:configuration_file')}</span>
            <code>{snapshot.path}</code>
          </div>
          <div className="gateway-status" role="status" data-pending={snapshot.restartRequired}>
            <strong>
              {snapshot.restartRequired
                ? t('settings:saved_restart_to_apply')
                : t('settings:saved_and_running_configurations_match')}
            </strong>
            <span>{t('settings:saving_does_not_restart_the_service_or_interrupt')}</span>
          </div>
          {!snapshot.writable && <p className="gateway-error">{snapshot.readOnlyReason}</p>}
          {notice && (
            <p className="gateway-notice" role="status">
              {displayMessage(notice)}
            </p>
          )}
          {conflict && (
            <div className="gateway-conflict">
              <p>{t('settings:reloading_discards_current_edits_and_loads_the_latest')}</p>
              <Button variant="secondary" disabled={busy} onClick={() => void reload()}>
                {t('settings:discard_edits_and_reload')}
              </Button>
            </div>
          )}
          {confirmClose ? (
            <section className="gateway-review" aria-label={t('settings:confirm_discarding_edits')}>
              <h3>{t('settings:discard_unsaved_changes')}</h3>
              <p>{t('settings:the_configuration_file_has_not_been_changed')}</p>
              <div className="project-dialog-actions">
                <Button variant="secondary" onClick={() => setConfirmClose(false)}>
                  {t('settings:keep_editing')}
                </Button>
                <Button variant="destructive" onClick={onClose}>
                  {t('settings:discard_changes_and_close')}
                </Button>
              </div>
            </section>
          ) : preview ? (
            <section
              className="gateway-review"
              aria-label={
                imported
                  ? t('settings:import_configuration_preview')
                  : t('settings:save_configuration_preview')
              }
            >
              <h3>
                {imported
                  ? t('settings:preview_imported_configuration')
                  : t('settings:confirm_configuration_changes')}
              </h3>
              <p>
                {imported
                  ? t('settings:applying_to_the_form_replaces_editable_settings_but')
                  : t('settings:these_changes_apply_after_restarting_the_service_confirm')}
              </p>
              {imported && (
                <p>
                  {t('settings:keep_the_current_data_directory_and_initial_project', {
                    v0:
                      imported.preserved.length > 0
                        ? t('settings:ignored_from_the_imported_file', {
                            v0: formatList(imported.preserved),
                          })
                        : '',
                  })}
                </p>
              )}
              {changes.length ? (
                <div className="gateway-changes">
                  {changes.map((change) => (
                    <div key={change.label}>
                      <strong>{change.label}</strong>
                      <span>
                        {t('settings:saved', { v0: change.before || t('settings:not_set') })}
                      </span>
                      <span>
                        {t('settings:change_to', { v0: change.after || t('settings:not_set') })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>{t('settings:no_differences_from_the_saved_configuration')}</p>
              )}
              <details className="gateway-json">
                <summary>{t('settings:view_full_json')}</summary>
                <pre>{JSON.stringify(preview, null, 2)}</pre>
              </details>
              <div className="project-dialog-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setImported(undefined);
                    setReview(undefined);
                  }}
                >
                  {t('settings:back_to_editing')}
                </Button>
                {imported ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setForm(configForm(imported.config));
                      setFieldErrors({});
                      setImported(undefined);
                      setNotice(
                        message('settings:imported_configuration_applied_to_form_not_saved_yet'),
                      );
                    }}
                  >
                    {t('settings:apply_to_form')}
                  </Button>
                ) : (
                  <Button
                    disabled={busy || conflict || !changes.length}
                    onClick={() =>
                      void run(async () => {
                        const next = await api.saveGatewayConfig(snapshot.revision, preview);
                        setSnapshot(next);
                        setForm(configForm(next.saved));
                        setReview(undefined);
                        setNotice(
                          next.restartRequired
                            ? message(
                                'settings:configuration_saved_restart_the_service_manually_when_convenient',
                              )
                            : message(
                                'settings:configuration_saved_and_matches_the_running_configuration',
                              ),
                        );
                      })
                    }
                  >
                    {busy ? t('common:saving') : t('settings:confirm_save')}
                  </Button>
                )}
              </div>
            </section>
          ) : (
            <>
              <div className="gateway-tools">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !snapshot.writable}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} aria-hidden="true" />
                  {t('settings:import_configuration')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void exportFile()}
                >
                  <Download size={15} aria-hidden="true" />
                  {t('settings:export_saved_configuration')}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  aria-label={t('settings:choose_configuration_file')}
                  hidden
                  onChange={(event) => void importFile(event)}
                />
              </div>
              <p className="gateway-help">
                {t('settings:import_updates_service_settings_only_export_includes_initial')}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const errors = configFormErrors(form);
                  setFieldErrors(errors);
                  const invalid = configFields.find((item) => errors[item.key]);
                  if (invalid) {
                    requestAnimationFrame(() => {
                      const input = document.getElementById(`gateway-${invalid.key}`);
                      input?.closest('details')?.setAttribute('open', '');
                      input?.focus({ preventScroll: true });
                      input?.closest('label')?.scrollIntoView({ block: 'center' });
                    });
                    return;
                  }
                  void run(async () => {
                    setReview(
                      (await api.importGatewayConfig(formConfig(form, snapshot.saved))).config,
                    );
                  });
                }}
              >
                <fieldset disabled={busy || !snapshot.writable}>
                  <section className="gateway-section">
                    <h3>{t('settings:network_and_access')}</h3>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'network').map(field)}
                      <label className="project-field">
                        <span>{t('common:authentication_mode')}</span>
                        <Select
                          value={form.mode}
                          disabled={busy || !snapshot.writable}
                          onValueChange={(value) =>
                            setForm({ ...form, mode: value as ConfigForm['mode'] })
                          }
                        >
                          <SelectTrigger aria-label={t('common:authentication_mode')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="local">
                              {t('settings:local_tailscale_local')}
                            </SelectItem>
                            <SelectItem value="cloudflare-access">Cloudflare Access</SelectItem>
                          </SelectContent>
                        </Select>
                        <small>
                          {t('settings:local_mode_listens_only_on_loopback_addresses_use')}
                        </small>
                        {form.mode !== running?.mode && (
                          <small className="gateway-running">
                            {t('settings:currently_running', { v0: running?.mode })}
                          </small>
                        )}
                      </label>
                    </div>
                  </section>
                  <section className="gateway-section">
                    <h3>Codex</h3>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'codex').map(field)}
                    </div>
                  </section>
                  <section className="gateway-section">
                    <h3>{t('settings:data_and_projects')}</h3>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'projects').map(field)}
                    </div>
                    <div className="gateway-file">
                      <span>{t('settings:data_directory_read_only')}</span>
                      <code>{snapshot.saved.dataDir}</code>
                      <span>{t('settings:current_runtime_directory')}</span>
                      <code>{snapshot.running.dataDir}</code>
                    </div>
                    <p className="gateway-help">
                      {t('settings:changing_the_data_directory_requires_database_migration_while')}
                    </p>
                  </section>
                  <details className="gateway-section">
                    <summary>{t('settings:advanced_settings')}</summary>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'advanced').map(field)}
                    </div>
                  </details>
                </fieldset>
                <div className="gateway-save-bar">
                  <span>
                    {dirty ? t('settings:unsaved_changes') : t('settings:no_unsaved_changes')}
                  </span>
                  <Button type="submit" disabled={busy || !dirty || !snapshot.writable || conflict}>
                    {busy ? t('settings:validating') : t('settings:review_changes')}
                  </Button>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </dialog>
  );
}

import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Zap } from 'lucide-react';
import type {
  ModelDefaults,
  ModelDefaultsResult,
  ModelInfo,
  Settings,
  ThreadView,
} from '../../shared/types';
import { useRuntimeDefaults } from '../hooks/useRuntimeDefaults';
import { chooseModel, pendingSettings, selectedModelDefaults, speedLabel } from '../lib/settings';
import { Icon } from './Icon';
import { PermissionDetails, PermissionModeSelect } from './PermissionModeSelect';
import { permissionModes } from '../lib/permissions';
import { permissionLabel } from '../lib/settings';
import { ModelSettingsPopover } from './ModelSettingsPopover';
import { ReasoningGauge } from './ReasoningGauge';
import { ControlHint } from './ControlHint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function SettingsPanel({
  settings,
  projectName,
  attachmentControl,
  children,
  models,
  thread,
  projectId,
  runtimeKey,
  disabled,
  threadLoading,
  onChange,
  onSaveModelDefaults,
  savingModelDefaults,
}: {
  settings: Settings;
  projectName?: string;
  attachmentControl: ReactNode;
  children: ReactNode;
  models: ModelInfo[];
  thread?: ThreadView;
  projectId?: string;
  runtimeKey?: string;
  disabled: boolean;
  threadLoading?: boolean;
  onChange: (settings: Settings) => void;
  onSaveModelDefaults: (settings: ModelDefaults) => Promise<ModelDefaultsResult | undefined>;
  savingModelDefaults: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const advancedId = useId();
  const effortHintId = useId();
  const speedHintId = useId();
  const scope = JSON.stringify([projectId, thread?.id]);
  const [saveNotice, setSaveNotice] = useState<{
    scope: string;
    settings: ModelDefaults;
    state: 'saving' | 'saved' | 'overridden' | 'error';
  }>();
  const notice = saveNotice?.scope === scope ? saveNotice : undefined;
  const saving = savingModelDefaults || notice?.state === 'saving';
  useEffect(() => {
    setModelMenuOpen(false);
    setEffortMenuOpen(false);
  }, [disabled, thread?.id, projectId]);
  useEffect(() => setExpanded(false), [thread?.id, projectId]);
  const defaults = useRuntimeDefaults(
    thread?.managed || threadLoading ? undefined : projectId,
    runtimeKey,
  );
  const current = thread ? thread.runtimeSettings : defaults.value;
  // A saved/occupied thread has no effective permission query. Defaults supply availability
  // for a future fork only; never use their permission values as the thread's actual state.
  const permissions =
    current?.permissionCapabilities || thread?.managed
      ? current
      : {
          ...current,
          model: current?.model ?? null,
          reasoningEffort: current?.reasoningEffort ?? null,
          permissionCapabilities: defaults.value?.permissionCapabilities,
        };
  const unknown =
    threadLoading || (defaults.loading && !thread)
      ? t('common:loading_2')
      : t('common:not_reported');
  const model = settings.model ?? current?.model ?? '';
  const effort = settings.reasoningEffort ?? current?.reasoningEffort ?? '';
  const effortTierLabel = effort === 'max' ? 'Max' : effort === 'ultra' ? 'Ultra' : null;
  const tier = settings.serviceTier !== undefined ? settings.serviceTier : current?.serviceTier;
  const fast = tier === 'fast';
  const selectedModel = models.find((entry) => entry.id === model);
  const fastAvailable = selectedModel?.serviceTiers?.includes('fast');
  const changes = pendingSettings(settings, current);
  const pending = Object.keys(changes).length > 0;
  const source = thread
    ? thread.managed
      ? t('settings:current_session_settings')
      : t('settings:saved_session_settings')
    : t('settings:new_session_defaults');
  async function saveModelDefaults(selection: ModelDefaults) {
    setSaveNotice({ scope, settings: selection, state: 'saving' });
    try {
      const result = await onSaveModelDefaults(selection);
      setSaveNotice({
        scope,
        settings: selection,
        state:
          result?.status === 'ok'
            ? 'saved'
            : result?.status === 'okOverridden'
              ? 'overridden'
              : 'error',
      });
    } catch {
      setSaveNotice({ scope, settings: selection, state: 'error' });
    }
  }
  return (
    <div className="settings-panel" role="group" aria-label={t('settings:runtime_settings')}>
      {pending && (
        <div className="settings-pending" role="status">
          <span>
            {t('settings:current', {
              v0: !thread
                ? t('settings:applies_when_creating_a_session')
                : thread.managed
                  ? t('settings:applies_to_the_next_task')
                  : t('settings:applies_when_sending_after_resume_or_forking'),
              v1: current?.model ?? t('common:not_reported'),
              v2: current?.reasoningEffort ?? t('common:not_reported'),
              v3:
                changes.serviceTier !== undefined &&
                t('settings:pending_speed_current', {
                  v0: speedLabel(changes.serviceTier),
                  v1: speedLabel(current?.serviceTier, unknown),
                }),
              v4:
                changes.permissionMode &&
                t('settings:pending_permissions_current', {
                  v0: permissionModes[changes.permissionMode].label,
                  v1: permissionLabel(current),
                }),
            })}
          </span>
          <button
            type="button"
            disabled={disabled || saving}
            onClick={() => {
              onChange({});
              if (notice?.state === 'error') setSaveNotice(undefined);
            }}
          >
            {thread && (changes.model !== undefined || changes.reasoningEffort !== undefined)
              ? t('settings:undo_session_changes')
              : t('settings:undo_changes')}
          </button>
        </div>
      )}
      {notice && (
        <p className="settings-defaults" data-state={notice.state} role="status">
          {notice.state === 'saving'
            ? t('settings:saving_default_model_and_reasoning_effort')
            : notice.state === 'saved'
              ? t('settings:saved_as_codex_defaults_for_new_sessions')
              : notice.state === 'overridden'
                ? t('settings:defaults_saved_but_overridden_by_higher_priority_configuration')
                : t('settings:could_not_confirm_defaults_were_saved_pending_selections')}
          {notice.state === 'error' && (
            <button
              type="button"
              disabled={disabled || saving}
              onClick={() => void saveModelDefaults(notice.settings)}
            >
              {t('settings:save_defaults_again')}
            </button>
          )}
        </p>
      )}
      {!thread && defaults.error && (
        <p className="settings-error" role="status">
          {displayMessage(defaults.error)}{' '}
          <button type="button" onClick={defaults.retry}>
            {t('settings:retry')}
          </button>
        </p>
      )}
      {expanded && (
        <div className="settings-fields" id={advancedId}>
          <PermissionDetails
            current={permissions}
            source={source}
            settings={changes}
            thread={Boolean(thread)}
            unknown={unknown}
          />
        </div>
      )}
      <div className="composer-actions">
        <div className="composer-context">
          {attachmentControl}
          <ControlHint asChild content={projectName ?? t('common:unassigned')}>
            <span className="composer-target">
              <Icon name="folder" size={14} />
              <span>{projectName ?? t('common:unassigned')}</span>
            </span>
          </ControlHint>
          <PermissionModeSelect
            settings={changes}
            current={permissions}
            unknown={unknown}
            disabled={disabled || Boolean(threadLoading)}
            scope={`${projectId}:${thread?.id ?? ''}:${runtimeKey}`}
            onChange={onChange}
          />
          <ControlHint asChild content={t('common:permission_details')}>
            <button
              className="settings-details-toggle"
              type="button"
              aria-label={t('common:permission_details')}
              aria-expanded={expanded}
              aria-controls={advancedId}
              onClick={() => setExpanded(!expanded)}
            >
              <Icon name="settings" size={14} />
            </button>
          </ControlHint>
        </div>
        <div className="composer-send-controls">
          <ModelSettingsPopover
            scope={scope}
            disabled={!model && !models.length}
            description={
              <>
                <span>{t('settings:model', { v0: model || unknown })}</span>
                <span>{t('settings:reasoning_effort', { v0: effort || unknown })}</span>
                <span>{speedLabel(tier, unknown)}</span>
              </>
            }
            summary={
              <>
                {fast && <Zap size={14} aria-hidden="true" className="settings-summary-fast" />}
                <span className="settings-model-value">{model || unknown}</span>
                <span className="settings-summary-effort reasoning-tier" data-effort={effort}>
                  {effort || unknown}
                </span>
              </>
            }
          >
            <Select
              value={model}
              disabled={disabled || !models.length}
              open={modelMenuOpen}
              onOpenChange={(open) => {
                if (!saving || !open) setModelMenuOpen(open);
              }}
              onValueChange={(value) => {
                if (saving) return;
                const selected = models.find((entry) => entry.id === value);
                if (selected) {
                  onChange(chooseModel(settings, current, selected));
                  void saveModelDefaults(selectedModelDefaults(settings, current, selected));
                }
              }}
            >
              <ControlHint
                content={t('settings:model', { v0: model || unknown })}
                suppressed={modelMenuOpen}
              >
                <SelectTrigger
                  className="settings-choice settings-model"
                  aria-label={t('settings:model_2')}
                  aria-disabled={saving || undefined}
                  data-value={model}
                >
                  <span className="settings-model-value">
                    <SelectValue placeholder={unknown}>{model || unknown}</SelectValue>
                  </span>
                </SelectTrigger>
              </ControlHint>
              <SelectContent side="top" aria-label={t('settings:model_2')}>
                {model && !selectedModel && (
                  <SelectItem value={model} disabled>
                    {model}
                  </SelectItem>
                )}
                {models.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={effort}
              disabled={disabled || !selectedModel?.reasoningEfforts.length}
              open={effortMenuOpen}
              onOpenChange={(open) => {
                if (!saving || !open) setEffortMenuOpen(open);
              }}
              onValueChange={(value) => {
                if (saving) return;
                onChange(pendingSettings({ ...settings, reasoningEffort: value }, current));
                void saveModelDefaults({ model, reasoningEffort: value });
              }}
            >
              <ControlHint
                id={effortHintId}
                suppressed={effortMenuOpen}
                content={
                  <>
                    <span>{t('settings:reasoning_effort', { v0: effort || unknown })}</span>
                    {changes.reasoningEffort !== undefined && (
                      <span>
                        {t('settings:pending_current', { v0: current?.reasoningEffort ?? unknown })}
                      </span>
                    )}
                  </>
                }
              >
                <SelectTrigger
                  className="settings-choice settings-effort reasoning-tier"
                  aria-label={t('settings:reasoning_effort_2')}
                  aria-disabled={saving || undefined}
                  aria-describedby={effortHintId}
                  data-value={effort}
                  data-effort={effort}
                >
                  <span className="reasoning-effort-display" key={effort} aria-hidden="true">
                    <ReasoningGauge effort={effort} />
                    {effortTierLabel && (
                      <span className="reasoning-tier-label">{effortTierLabel}</span>
                    )}
                  </span>
                  <span className="settings-effort-value">
                    <SelectValue placeholder={unknown}>{effort || unknown}</SelectValue>
                  </span>
                </SelectTrigger>
              </ControlHint>
              <SelectContent side="top" aria-label={t('settings:reasoning_effort_2')}>
                {effort && !selectedModel?.reasoningEfforts.includes(effort) && (
                  <SelectItem
                    value={effort}
                    disabled
                    className="reasoning-tier"
                    data-effort={effort}
                  >
                    {effort}
                  </SelectItem>
                )}
                {selectedModel?.reasoningEfforts.map((entry) => (
                  <SelectItem
                    key={entry}
                    value={entry}
                    className="reasoning-tier"
                    data-effort={entry}
                  >
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ControlHint
              id={speedHintId}
              content={
                <>
                  <span>{speedLabel(tier, unknown)}</span>
                  <span>
                    {fast
                      ? t('settings:turn_fast_off')
                      : fastAvailable
                        ? t('settings:turn_fast_on_faster_replies_increased_usage')
                        : t('settings:fast_is_unavailable_for_this_model')}
                  </span>
                  {changes.serviceTier !== undefined && (
                    <span>
                      {t('settings:pending_current', {
                        v0: speedLabel(current?.serviceTier, unknown),
                      })}
                    </span>
                  )}
                </>
              }
            >
              <button
                type="button"
                className="settings-choice settings-speed"
                aria-label={t('settings:fast_mode')}
                aria-describedby={speedHintId}
                aria-pressed={tier === undefined ? 'mixed' : fast}
                disabled={disabled || Boolean(threadLoading) || (!fast && !fastAvailable)}
                data-fast={fast}
                data-pending={changes.serviceTier !== undefined}
                onClick={() =>
                  onChange(
                    pendingSettings({ ...settings, serviceTier: fast ? null : 'fast' }, current),
                  )
                }
              >
                <Zap
                  size={18}
                  strokeWidth={1.7}
                  fill={fast ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
                <span>{t('settings:fast_mode')}</span>
                <span className="settings-speed-state" aria-hidden="true">
                  <span />
                </span>
              </button>
            </ControlHint>
          </ModelSettingsPopover>
          {children}
        </div>
      </div>
    </div>
  );
}

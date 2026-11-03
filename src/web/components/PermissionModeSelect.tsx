import { t } from '../i18n';
import { useEffect, useState } from 'react';
import { permissionModes, permissionModeUnavailable } from '../lib/permissions';
import type { PermissionMode, RuntimeSettings, Settings } from '../../shared/types';
import { choosePermissionMode, permissionLabel, reportedPermissionMode } from '../lib/settings';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function PermissionModeSelect({
  settings,
  current,
  unknown,
  disabled,
  scope,
  onChange,
}: {
  settings: Settings;
  current?: RuntimeSettings;
  unknown: string;
  disabled: boolean;
  scope?: string;
  onChange: (settings: Settings) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope, disabled]);
  const value = settings.permissionMode ?? reportedPermissionMode(current) ?? '';
  const label = settings.permissionMode
    ? permissionModes[settings.permissionMode].label
    : permissionLabel(current, unknown);
  return (
    <Select
      value={value}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(value) => {
        const mode = value as PermissionMode;
        if (
          mode in permissionModes &&
          !permissionModeUnavailable(
            mode,
            current?.permissionCapabilities,
            settings.model ?? current?.model,
          )
        )
          onChange(choosePermissionMode(settings, current, mode));
      }}
    >
      <ControlHint
        content={t('settings:permission_mode', {
          v0: label,
          v1: settings.permissionMode ? t('settings:pending') : '',
        })}
        suppressed={open}
      >
        <SelectTrigger
          className="settings-policy"
          aria-label={t('settings:permission_mode_2')}
          data-value={value}
        >
          <Icon name="shield" size={16} />
          <span className="permission-mode-label">
            <SelectValue placeholder={unknown}>{label}</SelectValue>
          </span>
          {settings.permissionMode && (
            <span className="permission-pending-dot" aria-label={t('settings:pending_2')} />
          )}
        </SelectTrigger>
      </ControlHint>
      <SelectContent
        className="permission-mode-menu"
        side="top"
        align="start"
        aria-label={t('settings:permission_mode_2')}
      >
        {value === 'custom' && (
          <SelectItem value="custom" disabled>
            {t('settings:keep_current_settings', { v0: label })}
          </SelectItem>
        )}
        {(Object.keys(permissionModes) as PermissionMode[]).map((mode) => {
          const preset = permissionModes[mode];
          const reason = permissionModeUnavailable(
            mode,
            current?.permissionCapabilities,
            settings.model ?? current?.model,
          );
          return (
            <SelectItem
              key={mode}
              value={mode}
              textValue={preset.label}
              disabled={Boolean(reason)}
              description={
                <span className="permission-description">
                  <span>{preset.description}</span>
                  {reason && <span className="permission-unavailable">{reason}</span>}
                </span>
              }
            >
              <strong>{preset.label}</strong>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

import type { RuntimeSettings, Settings } from '../../shared/types';
import { t } from '../i18n';
import { permissionModes } from '../lib/permissions';
import { choosePermissionMode, permissionLabel, reportedPermissionMode } from '../lib/settings';
import { PermissionModeSelect } from './PermissionModeSelect';

export function SessionPermissionModeSelect({
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
  scope: string;
  onChange: (settings: Settings) => void;
}) {
  const value = settings.permissionMode ?? reportedPermissionMode(current) ?? '';
  const label = settings.permissionMode
    ? permissionModes[settings.permissionMode].label
    : permissionLabel(current, unknown);
  return (
    <PermissionModeSelect<'custom'>
      value={value}
      label={t('settings:permission_mode_2')}
      selectedLabel={label}
      hint={t('settings:permission_mode', {
        v0: label,
        v1: settings.permissionMode ? t('settings:pending') : '',
      })}
      pendingLabel={settings.permissionMode ? t('settings:pending_2') : undefined}
      triggerClassName="settings-policy"
      side="top"
      align="start"
      disabled={disabled}
      scope={scope}
      capabilities={current?.permissionCapabilities}
      model={settings.model ?? current?.model}
      extraOptions={
        value === 'custom'
          ? [
              {
                value: 'custom',
                label: t('settings:keep_current_settings', { v0: label }),
                icon: 'settings',
                disabled: true,
              },
            ]
          : undefined
      }
      onChange={(mode) => {
        if (mode !== 'custom') onChange(choosePermissionMode(settings, current, mode));
      }}
    />
  );
}

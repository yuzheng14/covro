import type { RuntimeSettings, Settings } from '../../shared/types';
import { t } from '../i18n';
import { pendingSettings } from '../lib/settings';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function CollaborationModeSelect({
  settings,
  current,
  disabled,
  onChange,
}: {
  settings: Settings;
  current?: RuntimeSettings;
  disabled: boolean;
  onChange: (settings: Settings) => void;
}) {
  return (
    <Select
      value={settings.collaborationMode ?? current?.collaborationMode ?? ''}
      disabled={disabled}
      onValueChange={(value) =>
        onChange(
          pendingSettings(
            { ...settings, collaborationMode: value as Settings['collaborationMode'] },
            current,
          ),
        )
      }
    >
      <SelectTrigger aria-label={t('commands:mode')} className="settings-choice collaboration-mode">
        <SelectValue placeholder={t('commands:modeUnknown')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t('commands:executeMode')}</SelectItem>
        <SelectItem value="plan">{t('commands:planMode')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

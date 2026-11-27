import { useEffect, useState, type ComponentProps } from 'react';
import type { PermissionCapabilities, PermissionMode } from '../../shared/types';
import { permissionModes, permissionModeUnavailable } from '../lib/permissions';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type IconName = ComponentProps<typeof Icon>['name'];
type PermissionOption<Value extends string> = {
  value: Value;
  label: string;
  icon: IconName;
  description?: string;
  disabled?: boolean;
  unavailableReason?: string;
};

const modeIcons: Record<PermissionMode, IconName> = {
  ask: 'chat',
  'auto-review': 'shield',
  'full-access': 'terminal',
  'read-only': 'search',
};
const modes = Object.keys(permissionModes) as PermissionMode[];

export function PermissionModeSelect<Extra extends string>({
  value,
  label,
  selectedLabel,
  hint,
  pendingLabel,
  triggerClassName,
  side,
  align,
  scope,
  disabled,
  capabilities,
  model,
  extraOptions = [],
  onChange,
}: {
  value: PermissionMode | NoInfer<Extra> | '';
  label: string;
  selectedLabel?: string;
  hint?: string;
  pendingLabel?: string;
  triggerClassName?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  scope?: string;
  disabled: boolean;
  capabilities?: PermissionCapabilities;
  model?: string | null;
  extraOptions?: readonly PermissionOption<Extra>[];
  onChange: (value: PermissionMode | NoInfer<Extra>) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope, disabled]);

  const options: PermissionOption<PermissionMode | Extra>[] = [
    ...extraOptions,
    ...modes.map((mode) => ({
      value: mode,
      label: permissionModes[mode].label,
      description: permissionModes[mode].description,
      icon: modeIcons[mode],
      unavailableReason: permissionModeUnavailable(mode, capabilities, model),
    })),
  ];
  const trigger = (
    <SelectTrigger className={triggerClassName} aria-label={label} data-value={value}>
      {hint && <Icon name="shield" size={16} />}
      <SelectValue placeholder={selectedLabel}>{selectedLabel}</SelectValue>
      {pendingLabel && <span className="permission-pending-dot" aria-label={pendingLabel} />}
    </SelectTrigger>
  );
  return (
    <Select
      value={value}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(selected) => {
        const option = options.find(({ value }) => value === selected);
        if (!disabled && option && !option.disabled && !option.unavailableReason)
          onChange(option.value);
      }}
    >
      <ControlHint content={hint} suppressed={open}>
        {trigger}
      </ControlHint>
      <SelectContent className="permission-mode-menu" side={side} align={align} aria-label={label}>
        {options.map(({ value, label, icon, description, disabled, unavailableReason }) => (
          <SelectItem
            key={value}
            value={value}
            textValue={label}
            disabled={disabled || Boolean(unavailableReason)}
            icon={<Icon name={icon} />}
            description={
              (description || unavailableReason) && (
                <>
                  {description}
                  {unavailableReason && (
                    <span className="permission-unavailable">{unavailableReason}</span>
                  )}
                </>
              )
            }
          >
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

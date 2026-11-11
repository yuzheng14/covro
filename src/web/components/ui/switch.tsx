import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import './switch.css';

type SwitchProps = Omit<ComponentProps<'button'>, 'children' | 'role' | 'aria-checked' | 'type'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** Immediate settings toggle. Native button activation supports Space/Enter. */
export function Switch({ checked, onCheckedChange, onClick, className, ...props }: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn('switch-control', className)}
      onClick={(event) => {
        if (props['aria-disabled'] === true || props['aria-disabled'] === 'true') {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}

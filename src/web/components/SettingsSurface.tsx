import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  type ComponentPropsWithoutRef,
  type MutableRefObject,
} from 'react';

// Ask the active editor to resolve pending writes and unsaved edits before navigation.
export const SettingsNavigationContext = createContext<MutableRefObject<
  (() => void) | null
> | null>(null);

export function useSettingsLeaveGuard(close: () => void) {
  const guard = useContext(SettingsNavigationContext);
  useLayoutEffect(() => {
    if (!guard) return;
    guard.current = close;
    return () => {
      guard.current = null;
    };
  });
}

export const SettingsSurface = forwardRef<HTMLDialogElement, ComponentPropsWithoutRef<'dialog'>>(
  function SettingsSurface({ children, className, onCancel, ...props }, ref) {
    const embedded = useContext(SettingsNavigationContext) !== null;
    if (embedded)
      return (
        <section {...props} className={`${className ?? ''} settings-embedded`}>
          {children}
        </section>
      );
    return (
      <dialog {...props} ref={ref} className={className} onCancel={onCancel}>
        {children}
      </dialog>
    );
  },
);

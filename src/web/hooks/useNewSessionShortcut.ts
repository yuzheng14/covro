import { useEffect, useEffectEvent } from 'react';

export function newSessionShortcut(platform: string) {
  const mac = /Mac|iPhone|iPad|iPod/i.test(platform);
  return {
    mac,
    label: mac ? '⌘ + ⌥ + N' : 'Ctrl + Alt + N',
    aria: mac ? 'Meta+Alt+N' : 'Control+Alt+N',
  };
}

/** Keep navigation behind editors' key handlers and out of modal/popup interactions. */
export function useNewSessionShortcut(enabled: boolean, onCreate: () => void) {
  const { mac } = newSessionShortcut(navigator.platform);
  const create = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    event.preventDefault();
    onCreate();
  });
  useEffect(() => {
    let composing = false;
    let compositionEndedAt = -Infinity;
    const reset = () => {
      composing = false;
      compositionEndedAt = -Infinity;
    };
    const startComposition = () => {
      composing = true;
    };
    const endComposition = () => {
      composing = false;
      compositionEndedAt = performance.now();
    };
    const release = (event: KeyboardEvent) => {
      if (event.code === 'KeyN') compositionEndedAt = -Infinity;
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        composing ||
        performance.now() - compositionEndedAt < 100 ||
        event.getModifierState('AltGraph') ||
        !event.altKey ||
        event.shiftKey ||
        (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) ||
        // Option and non-Latin layouts can change `key`; use the physical N key.
        (event.code ? event.code !== 'KeyN' : event.key.toLowerCase() !== 'n')
      )
        return;
      if (
        document.querySelector(
          'dialog:modal, [aria-modal="true"], [role="listbox"], [role="menu"], [popover]:popover-open',
        ) ||
        (event.target instanceof Element &&
          event.target.closest(
            'dialog[open], [role="dialog"], [role="alertdialog"], [role="combobox"]',
          ))
      )
        return;
      create(event);
    };
    document.addEventListener('compositionstart', startComposition, true);
    document.addEventListener('compositionend', endComposition, true);
    document.addEventListener('blur', reset, true);
    document.addEventListener('keyup', release);
    document.addEventListener('keydown', keydown);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('compositionstart', startComposition, true);
      document.removeEventListener('compositionend', endComposition, true);
      document.removeEventListener('blur', reset, true);
      document.removeEventListener('keyup', release);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', reset);
    };
  }, [mac]);
}

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';

/** Native light dismissal and focus restoration, with room for the nested Select portals. */
export function ModelSettingsPopover({
  summary,
  description,
  children,
  scope,
  disabled,
}: {
  summary: ReactNode;
  description: ReactNode;
  children: ReactNode;
  scope: string;
  disabled: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    panel.current?.hidePopover();
  }, [scope, disabled]);
  useEffect(() => {
    if (!open) return;
    function position() {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = Math.min(300, (viewport?.width ?? innerWidth) - 24);
      const height = viewport?.height ?? innerHeight;
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.max(left + 12, Math.min(anchor.right - width, left + (viewport?.width ?? innerWidth) - width - 12))}px`;
      const above = anchor.top - top - 20;
      const below = top + height - anchor.bottom - 20;
      const useAbove = above >= Math.min(240, below);
      popup.style.maxHeight = `${Math.max(0, useAbove ? above : below)}px`;
      popup.style.setProperty('--model-settings-height', popup.style.maxHeight);
      popup.style.top = useAbove ? 'auto' : `${anchor.bottom + 8}px`;
      popup.style.bottom = useAbove ? `${innerHeight - anchor.top + 8}px` : 'auto';
    }
    position();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  return (
    <>
      <ControlHint content={description} suppressed={open} className="settings-model-summary">
        <button
          ref={trigger}
          type="button"
          className="settings-choice settings-model-toggle"
          aria-label={t('settings:model_settings')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          popoverTarget={id}
        >
          {summary}
          <Icon name="down" size={13} />
        </button>
      </ControlHint>
      {createPortal(
        <div
          ref={panel}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={t('settings:model_settings')}
          className="model-settings-popover"
          onBeforeToggle={(event) => setOpen(event.newState === 'open')}
        >
          <div className="model-settings-heading">
            <strong>{t('settings:model_settings')}</strong>
            <button
              type="button"
              aria-label={t('settings:close_model_settings')}
              onClick={() => {
                panel.current?.hidePopover();
                trigger.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="model-settings-content">{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

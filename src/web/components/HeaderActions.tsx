import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Ellipsis } from 'lucide-react';
import { t } from '../i18n';
import { Button } from './ui/button';

/** Keep the same controls mounted when the toolbar becomes a native popover. */
export function HeaderActions({
  compact,
  trigger,
  onOpen,
  children,
}: {
  compact: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);

  const position = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    const popup = panel.current;
    if (!anchor || !popup) return;
    const top = anchor.bottom + 6;
    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    popup.style.setProperty('--topbar-tools-top', `${top}px`);
    popup.style.setProperty('--topbar-tools-right', `${Math.max(8, innerWidth - anchor.right)}px`);
    popup.style.setProperty(
      '--topbar-tools-max-height',
      `${Math.max(0, viewportBottom - top - 8)}px`,
    );
  }, [trigger]);

  useEffect(() => {
    if (!compact) return;
    const popup = panel.current;
    const viewport = window.visualViewport;
    const header = popup?.closest('.topbar');
    const resize = new ResizeObserver(position);
    if (header) resize.observe(header, { box: 'border-box' });
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      popup?.style.removeProperty('--topbar-tools-top');
      popup?.style.removeProperty('--topbar-tools-right');
      popup?.style.removeProperty('--topbar-tools-max-height');
    };
  }, [compact, position]);

  return (
    <>
      {compact && (
        <Button
          ref={trigger}
          className="topbar-more"
          data-compact-action=""
          variant="ghost"
          size="icon"
          aria-label={t('workspace:more_actions')}
          popoverTarget={id}
        >
          <Ellipsis size={22} aria-hidden="true" />
        </Button>
      )}
      <div
        ref={panel}
        id={id}
        className="topbar-tools"
        popover={compact ? 'auto' : undefined}
        onBeforeToggle={(event) => {
          if (event.newState !== 'open') return;
          position();
          onOpen();
        }}
        onClickCapture={(event) => {
          // Portalled dialogs still bubble through this React tree.
          const target = event.target;
          if (
            compact &&
            target instanceof Element &&
            event.currentTarget.contains(target) &&
            target.closest('button:not(:disabled)')
          ) {
            event.currentTarget.hidePopover();
            trigger.current?.focus();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

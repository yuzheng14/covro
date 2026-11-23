import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Ellipsis } from 'lucide-react';
import { t } from '../i18n';
import { Button } from './ui/button';

export const compactHeaderQuery =
  '(max-width: 760px), (max-width: 950px) and (max-height: 500px) and (pointer: coarse)';

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
    popup.style.top = `${top}px`;
    popup.style.maxHeight = `${Math.max(0, viewportBottom - top - 8)}px`;
  }, [trigger]);

  useEffect(() => {
    if (!compact) return;
    const popup = panel.current;
    const viewport = window.visualViewport;
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      popup?.style.removeProperty('top');
      popup?.style.removeProperty('max-height');
    };
  }, [compact, position]);

  return (
    <>
      {compact && (
        <Button
          ref={trigger}
          className="topbar-more"
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

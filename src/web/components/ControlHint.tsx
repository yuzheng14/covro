import {
  cloneElement,
  useCallback,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { cn } from '../lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

export function ControlHint({
  id: providedId,
  content,
  children,
  suppressed = false,
  className,
  asChild = false,
  side = 'top',
  align = 'end',
}: {
  id?: string;
  content: ReactNode;
  children: ReactNode;
  suppressed?: boolean;
  className?: string;
  asChild?: boolean;
  side?: ComponentProps<typeof TooltipContent>['side'];
  align?: ComponentProps<typeof TooltipContent>['align'];
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [open, setOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const portalRef = useCallback(
    (node: HTMLSpanElement | null) =>
      setPortalContainer(node?.closest<HTMLElement>('dialog, [popover]') ?? null),
    [],
  );
  const suppressRestoredFocus = useRef(false);
  useEffect(() => {
    if (suppressed) {
      setOpen(false);
      suppressRestoredFocus.current = true;
    }
    if (!suppressRestoredFocus.current) return;
    // Closing a Select restores focus to its trigger. Only fresh keyboard
    // navigation may reopen on focus; Radix handles fresh hover separately.
    const allowKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !suppressed) suppressRestoredFocus.current = false;
    };
    document.addEventListener('keydown', allowKeyboardFocus);
    return () => document.removeEventListener('keydown', allowKeyboardFocus);
  }, [suppressed]);

  if (!content) return children;

  const description = (
    <span id={id} className="sr-only control-hint-description" aria-hidden="true">
      {content}
    </span>
  );
  const describedChildren = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': children.props['aria-describedby'] ?? id })
    : children;
  return (
    <TooltipProvider>
      <Tooltip open={open && !suppressed} onOpenChange={(next) => setOpen(next && !suppressed)}>
        <TooltipTrigger
          asChild
          aria-describedby={asChild ? id : undefined}
          className={asChild ? className : undefined}
          onFocus={(event) => {
            if (suppressRestoredFocus.current || !event.target.matches(':focus-visible'))
              event.preventDefault();
          }}
        >
          {asChild ? (
            describedChildren
          ) : (
            <span ref={portalRef} className={cn('control-hint', className)}>
              {describedChildren}
              {description}
            </span>
          )}
        </TooltipTrigger>
        {/* Keep descriptions available while closed without adding layout children. */}
        {asChild && <TooltipPortal forceMount>{description}</TooltipPortal>}
        <TooltipContent
          container={portalContainer}
          side={side}
          align={align}
          sideOffset={portalContainer?.hasAttribute('popover') ? 4 : 8}
        >
          <div className="control-hint-content">{content}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

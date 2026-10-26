// shadcn/ui Select (MIT), adapted to this project's CSS and per-component Radix imports.
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/select.tsx
import type * as React from 'react';
import { createContext, useCallback, useContext, useId, useState } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

const SelectPortalContext = createContext<{
  container: HTMLElement | null;
  setContainer: (container: HTMLElement | null) => void;
}>({ container: null, setContainer: () => {} });

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <SelectPortalContext.Provider value={{ container, setContainer }}>
      <SelectPrimitive.Root {...props} />
    </SelectPortalContext.Provider>
  );
}
const SelectGroup = SelectPrimitive.Group;
function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  const { setContainer } = useContext(SelectPortalContext);
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      // Native dialogs and popovers paint above body portals.
      // Keep the menu in the same top layer as its own trigger.
      setContainer(node?.closest<HTMLElement>('dialog, [popover]') ?? null);
      if (typeof ref === 'function') return ref(node);
      if (ref) ref.current = node;
    },
    [ref, setContainer],
  );
  return (
    <SelectPrimitive.Trigger
      ref={triggerRef}
      data-slot="select-trigger"
      className={cn('select-trigger', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="select-chevron" size={14} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  align = 'end',
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const { container } = useContext(SelectPortalContext);
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn('select-content', className)}
        position={position}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn('select-label', className)} {...props} />;
}

function SelectItem({
  className,
  children,
  description,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & { description?: React.ReactNode }) {
  const descriptionId = useId();
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn('select-item', className)}
      aria-describedby={description ? descriptionId : undefined}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {description && (
        <span className="select-item-description" id={descriptionId}>
          {description}
        </span>
      )}
      <span className="select-item-indicator">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon size={14} />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton className={cn('select-scroll-button', className)} {...props}>
      <ChevronUpIcon size={14} />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton className={cn('select-scroll-button', className)} {...props}>
      <ChevronDownIcon size={14} />
    </SelectPrimitive.ScrollDownButton>
  );
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue };

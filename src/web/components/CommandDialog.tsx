import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function CommandDialog({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`project-dialog command-dialog${wide ? ' command-dialog-wide' : ''}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <h2 id={id}>{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('commands:closeDialog')}
          onClick={onClose}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

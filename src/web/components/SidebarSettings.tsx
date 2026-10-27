import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Gauge,
  ChevronRight,
  DatabaseBackup,
  Languages,
  Server,
  Settings,
} from 'lucide-react';
import { changeLocale, currentLocale, t } from '../i18n';
import { localeNames, supportedLocales, type Locale } from '../i18n/locales';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { SystemInfo } from '../../shared/types';
import { AccountUsage } from './AccountUsage';
import { Icon } from './Icon';

interface Props {
  system?: SystemInfo;
  offline?: boolean;
  notificationStatus: string;
  onNotificationSettings: () => void;
  onGatewaySettings: () => void;
  onBackups?: () => void;
}

export function SidebarSettings(props: Props) {
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <>
      <Button
        className="sidebar-settings-trigger"
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Settings size={16} aria-hidden="true" />
        {t('sidebar:settings')}
      </Button>
      {open && (
        <SettingsDialog
          {...props}
          onAccountUsage={() => setAccountOpen(true)}
          onClose={() => setOpen(false)}
        />
      )}
      {accountOpen && (
        <AccountUsage
          system={props.system}
          offline={props.offline ?? false}
          onClose={() => setAccountOpen(false)}
        />
      )}
    </>
  );
}

function SettingsDialog({
  onClose,
  onAccountUsage,
  ...props
}: Props & { onClose: () => void; onAccountUsage: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { onBackups } = props;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const close = () => {
    // Close while still mounted so the browser can restore focus to the footer trigger.
    dialog.current?.close();
    onClose();
  };
  const navigate = (action: () => void) => {
    close();
    action();
  };
  return (
    <dialog
      ref={dialog}
      className="project-dialog sidebar-settings-dialog"
      aria-labelledby="sidebar-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Settings size={20} aria-hidden="true" />
          <h2 id="sidebar-settings-title">{t('sidebar:settings')}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:close')} onClick={close}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <label className="language-selector">
        <Languages size={18} aria-hidden="true" />
        <span>{t('common:language')}</span>
        <Select
          value={currentLocale()}
          onValueChange={(value) => void changeLocale(value as Locale)}
        >
          <SelectTrigger aria-label={t('common:language')} data-value={currentLocale()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {supportedLocales.map((locale) => (
              <SelectItem key={locale} value={locale} lang={locale}>
                {localeNames[locale]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <div className="sidebar-settings-links">
        <Button variant="ghost" onClick={() => navigate(onAccountUsage)}>
          <Gauge size={18} aria-hidden="true" />
          <span className="sidebar-settings-label">{t('account:title')}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          aria-label={t('sidebar:browser_notifications_status', { v0: props.notificationStatus })}
          onClick={() => navigate(props.onNotificationSettings)}
        >
          <Bell size={18} aria-hidden="true" />
          <span className="sidebar-settings-label">{t('sidebar:browser_notifications')}</span>
          <span className="sidebar-settings-status">{props.notificationStatus}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        <Button variant="ghost" onClick={() => navigate(props.onGatewaySettings)}>
          <Settings size={18} aria-hidden="true" />
          <span className="sidebar-settings-label">{t('common:service_settings')}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        {onBackups && (
          <Button variant="ghost" onClick={() => navigate(onBackups)}>
            <DatabaseBackup size={18} aria-hidden="true" />
            <span className="sidebar-settings-label">{t('backups:title')}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="sidebar-settings-execution">
        <Server size={17} aria-hidden="true" />
        <div>
          <strong>{t('sidebar:runs_on_server')}</strong>
          <p>{t('sidebar:code_and_credentials_stay_on_the_computer_running')}</p>
        </div>
      </div>
    </dialog>
  );
}

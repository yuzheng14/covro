import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Bot,
  ChevronRight,
  DatabaseBackup,
  Gauge,
  Languages,
  Moon,
  Server,
  Settings,
  SlidersHorizontal,
  FileText,
} from 'lucide-react';
import { changeLocale, currentLocale, t } from '../i18n';
import { localeNames, supportedLocales, type Locale } from '../i18n/locales';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import type { SystemInfo } from '../../shared/types';
import type { BrowserNotifications } from '../hooks/useBrowserNotifications';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { GlobalDefaultsDialog } from './GlobalDefaultsDialog';
import { GlobalInstructionsEditor } from './GlobalInstructionsEditor';
import { AccountUsage } from './AccountUsage';
import { NotificationSettings } from './NotificationSettings';
import { GatewaySettings } from './GatewaySettings';
import { BackupSettings } from './BackupSettings';
import { SettingsNavigationContext } from './SettingsSurface';
import { Icon } from './Icon';

type Category = 'general' | 'ai' | 'account' | 'service';
type Detail = 'instructions' | 'notifications' | 'gateway' | 'backups';
const categories = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'ai', icon: Bot },
  { id: 'account', icon: Gauge },
  { id: 'service', icon: Server },
] as const;
interface Props {
  system?: SystemInfo;
  offline?: boolean;
  notifications: BrowserNotifications;
  notificationStatus: string;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onNotificationPanelChange: (open: boolean) => void;
  backupsAvailable?: boolean;
}
export function SidebarSettings(props: Props) {
  const open = props.settingsOpen;
  const setOpen = props.onSettingsOpenChange;
  const [category, setCategory] = useState<Category>('general');
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
          category={category}
          onCategory={setCategory}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function SettingsDialog({
  category,
  onCategory,
  onClose,
  ...props
}: Props & {
  category: Category;
  onCategory: (category: Category) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const guard = useRef<(() => void) | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const [detail, setDetail] = useState<Detail>();
  const [mobileIndex, setMobileIndex] = useState(true);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  const content = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    content.current?.scrollTo(0, 0);
    if (!mobileIndex || detail) content.current?.focus({ preventScroll: true });
  }, [category, detail, mobileIndex]);
  useEffect(() => {
    props.onNotificationPanelChange(detail === 'notifications');
    return () => props.onNotificationPanelChange(false);
  }, [detail, props.onNotificationPanelChange]);
  function close() {
    dialog.current?.close();
    onClose();
  }
  function navigate(action: () => void) {
    pending.current = action;
    if (guard.current) guard.current();
    else finishNavigation();
  }
  function finishNavigation() {
    const action = pending.current;
    pending.current = null;
    if (action) action();
    else close();
  }
  function selectCategory(next: Category) {
    if (next === category && !detail) {
      setMobileIndex(false);
      return;
    }
    navigate(() => {
      onCategory(next);
      setDetail(undefined);
      setMobileIndex(false);
    });
  }
  function back() {
    navigate(() => {
      if (detail) setDetail(undefined);
      else setMobileIndex(true);
    });
  }
  function entry(label: string, description: string, target: Detail, EntryIcon: typeof Bell) {
    return (
      <Button
        variant="ghost"
        className="settings-entry"
        aria-label={label}
        onClick={() => navigate(() => setDetail(target))}
      >
        <EntryIcon size={19} aria-hidden="true" />
        <span>
          <strong>{target === 'instructions' ? 'AGENTS.md' : label}</strong>
          <small>{description}</small>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </Button>
    );
  }
  return (
    <dialog
      ref={dialog}
      className="project-dialog sidebar-settings-dialog"
      aria-labelledby="sidebar-settings-title"
      data-mobile-index={mobileIndex && !detail}
      onCancel={(event) => {
        event.preventDefault();
        navigate(close);
      }}
    >
      <header className="settings-heading">
        <h2 id="sidebar-settings-title">{t('sidebar:settings')}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:close')}
          onClick={() => navigate(close)}
        >
          <Icon name="close" size={17} />
        </Button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('sidebar:settings_categories')}>
          {categories.map(({ id, icon: CategoryIcon }) => (
            <Button
              key={id}
              data-settings-category={id}
              variant="ghost"
              aria-current={category === id ? 'page' : undefined}
              onClick={() => selectCategory(id)}
            >
              <CategoryIcon size={18} aria-hidden="true" />
              <span>{t(`sidebar:settings_category_${id}`)}</span>
              <ChevronRight className="settings-mobile-chevron" size={16} aria-hidden="true" />
            </Button>
          ))}
        </nav>
        <div className="settings-content" ref={content} tabIndex={-1}>
          <Button
            variant="ghost"
            size="sm"
            className={`settings-back${detail ? ' settings-back-detail' : ''}`}
            onClick={back}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {detail ? t(`sidebar:settings_category_${category}`) : t('sidebar:settings_categories')}
          </Button>
          <SettingsNavigationContext.Provider value={guard}>
            {compact && mobileIndex && !detail ? null : detail === 'instructions' ? (
              <GlobalInstructionsEditor
                disabled={props.offline ?? false}
                onClose={finishNavigation}
              />
            ) : detail === 'notifications' ? (
              <NotificationSettings
                notifications={props.notifications}
                onClose={finishNavigation}
              />
            ) : detail === 'gateway' ? (
              <GatewaySettings onClose={finishNavigation} />
            ) : detail === 'backups' ? (
              <BackupSettings onClose={finishNavigation} />
            ) : category === 'general' ? (
              <>
                <div className="settings-pane-heading">
                  <h3>{t('sidebar:settings_category_general')}</h3>
                  <p>{t('sidebar:settings_browser_scope')}</p>
                </div>
                <section className="settings-section" aria-labelledby="settings-interface-title">
                  <h4 id="settings-interface-title">{t('sidebar:settings_interface')}</h4>
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
                  <label className="appearance-selector">
                    <Moon size={18} aria-hidden="true" />
                    <span>{t('common:appearance')}</span>
                    <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                      <SelectTrigger aria-label={t('common:appearance')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t('common:theme_system')}</SelectItem>
                        <SelectItem value="light">{t('common:theme_light')}</SelectItem>
                        <SelectItem value="dark">{t('common:theme_dark')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </section>
                <section
                  className="settings-section"
                  aria-labelledby="settings-notifications-title"
                >
                  <h4 id="settings-notifications-title">{t('sidebar:settings_notifications')}</h4>
                  {entry(
                    t('sidebar:browser_notifications'),
                    props.notificationStatus,
                    'notifications',
                    Bell,
                  )}
                </section>
              </>
            ) : category === 'ai' ? (
              <>
                <GlobalDefaultsDialog
                  disabled={props.offline ?? false}
                  onClose={finishNavigation}
                />
                <section className="settings-section" aria-labelledby="settings-instructions-title">
                  <h4 id="settings-instructions-title">{t('sidebar:instructions_edit')}</h4>
                  {entry(
                    t('sidebar:instructions_edit'),
                    t('sidebar:settings_instructions_help'),
                    'instructions',
                    FileText,
                  )}
                </section>
              </>
            ) : category === 'account' ? (
              <AccountUsage
                system={props.system}
                offline={props.offline ?? false}
                onClose={finishNavigation}
              />
            ) : (
              <>
                <div className="settings-pane-heading">
                  <h3>{t('sidebar:settings_category_service')}</h3>
                </div>
                <section className="settings-section" aria-labelledby="settings-server-title">
                  <h4 id="settings-server-title">{t('common:service_settings')}</h4>
                  {entry(
                    t('common:service_settings'),
                    t('sidebar:settings_service_help'),
                    'gateway',
                    Server,
                  )}
                </section>
                {props.backupsAvailable && (
                  <section className="settings-section" aria-labelledby="settings-data-title">
                    <h4 id="settings-data-title">{t('sidebar:settings_data')}</h4>
                    {entry(
                      t('backups:title'),
                      t('sidebar:settings_backups_help'),
                      'backups',
                      DatabaseBackup,
                    )}
                  </section>
                )}
                <div className="sidebar-settings-execution">
                  <Server size={17} aria-hidden="true" />
                  <div>
                    <strong>{t('sidebar:runs_on_server')}</strong>
                    <p>{t('sidebar:code_and_credentials_stay_on_the_computer_running')}</p>
                  </div>
                </div>
              </>
            )}
          </SettingsNavigationContext.Provider>
        </div>
      </div>
    </dialog>
  );
}

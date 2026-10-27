import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import type { BrowserNotifications } from '../hooks/useBrowserNotifications';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function NotificationSettings({
  notifications,
  onClose: onDismiss,
}: {
  notifications: BrowserNotifications;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onClose = () => {
    dialog.current?.close();
    onDismiss();
  };
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const { enabled, access, requesting, error, ready, initializing, testing, testResult } =
    notifications;
  const active = enabled && access === 'granted';
  const status = {
    default: t('notifications:permission_not_granted'),
    granted: t('notifications:permission_granted'),
    denied: t('notifications:blocked_by_browser'),
    unsupported: t('notifications:unsupported_browser'),
    insecure: t('notifications:secure_connection_required'),
  }[access];
  const unavailable = !['default', 'granted'].includes(access);
  return (
    <dialog
      ref={dialog}
      className="project-dialog notification-dialog"
      aria-labelledby="notification-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Bell size={20} aria-hidden="true" />
          <h2 id="notification-dialog-title">{t('notifications:browser_notifications')}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('notifications:close_notification_settings')}
          onClick={onClose}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p>{t('notifications:events_description')}</p>
      <div className="notification-control">
        <div>
          <strong>{t('notifications:browser_notifications')}</strong>
          <span role="status">
            {status} ·{' '}
            {active
              ? error || (!ready && !initializing)
                ? t('notifications:delivery_unavailable')
                : initializing
                  ? t('notifications:preparing_delivery')
                  : t('common:on')
              : t('common:off')}
          </span>
        </div>
        <Button
          role="switch"
          aria-label={t('notifications:browser_notifications')}
          aria-checked={active}
          aria-describedby="notification-permission-help"
          variant={active ? 'secondary' : 'default'}
          size="sm"
          disabled={requesting || (unavailable && !enabled)}
          onClick={() => void notifications.toggle()}
        >
          {requesting
            ? t('notifications:waiting_for_permission')
            : enabled
              ? t('notifications:disable_notifications')
              : t('notifications:enable_notifications')}
        </Button>
      </div>
      <p id="notification-permission-help" className="notification-help">
        {access === 'denied'
          ? t('notifications:allow_notifications_in_the_browser_s_site_settings')
          : access === 'insecure'
            ? t('notifications:use_https_localhost_or_127_0_0_1')
            : access === 'unsupported'
              ? t('notifications:use_a_desktop_browser_that_supports_system_notifications')
              : t('notifications:permission_is_requested_only_when_you_click_enable')}
      </p>
      {enabled && access === 'granted' && (
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready || initializing || testing}
          onClick={() => void notifications.test()}
        >
          {t('notifications:send_test_notification')}
        </Button>
      )}
      {testResult && !error && (
        <p className="notification-help" role="status">
          {displayMessage(testResult)}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {displayMessage(error)}
        </p>
      )}
      <section className="notification-background" aria-labelledby="notification-background-title">
        <h3 id="notification-background-title">
          {t('notifications:background_notifications_and_sleeping_tabs')}
        </h3>
        <p>{t('notifications:keep_this_page_and_browser_open_background_tabs')}</p>
        <details>
          <summary>{t('notifications:keep_this_site_active')}</summary>
          <ul>
            <li>
              {t('notifications:chrome_settings_performance_always_keep_these_sites_active')}
              <a
                href="https://support.google.com/chrome/answer/12929150?hl=zh-Hans"
                target="_blank"
                rel="noreferrer"
              >
                {t('notifications:settings_instructions')}
              </a>
            </li>
            <li>
              {t('notifications:edge_settings_system_and_performance_performance_always_keep')}
              <a
                href="https://support.microsoft.com/edge/learn-about-performance-features-in-microsoft-edge"
                target="_blank"
                rel="noreferrer"
              >
                {t('notifications:settings_instructions')}
              </a>
            </li>
          </ul>
          <p>{t('notifications:configure_this_manually_in_the_browser_names_may')}</p>
        </details>
      </section>
    </dialog>
  );
}

import { scopeKey } from '../../shared/workspace-scope';
import { message } from '../i18n/messages';
import { t } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttentionRequest, AttentionTarget, TurnCompletion } from '../../shared/types';
import { attentionKey } from '../../shared/thread-attention';
import { api } from '../lib/api';
import {
  NotificationDeliveryError,
  prepareNotificationDelivery,
  showBrowserNotification,
} from '../lib/notification-delivery';
import { parseNotificationURL, type NotificationDestination } from '../lib/notification-navigation';
import {
  claimCompletion,
  claimNotification,
  attentionNotification,
  completionNotification,
  notificationAccess,
  notificationsEnabled,
  NOTIFICATIONS_ENABLED_KEY,
} from '../lib/browser-notifications';

interface Options {
  navigationReady: boolean;
  projectName: (projectId: string) => string | undefined;
  openThread: (threadId: string, projectId: string, target?: AttentionTarget) => void;
}

export function useBrowserNotifications(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [access, setAccess] = useState(notificationAccess);
  const [requesting, setRequesting] = useState(false);
  const requestInFlight = useRef(false);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>();
  const [destination, setDestination] = useState<NotificationDestination>();

  const deliveryError = useCallback((problem: unknown) => {
    if (!mounted.current) return;
    const reason = problem instanceof NotificationDeliveryError ? problem.reason : 'delivery';
    setError(message(`notifications:delivery_error_${reason}`));
    setTestResult(undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      setEnabled(notificationsEnabled());
      setAccess(notificationAccess());
    };
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === NOTIFICATIONS_ENABLED_KEY) refresh();
    };
    const navigate = (value: unknown) => {
      const next = parseNotificationURL(value);
      if (next) setDestination(next);
      return next;
    };
    const fromURL = () => {
      if (navigate(window.location.href))
        history.replaceState(history.state, '', window.location.pathname + window.location.search);
    };
    const clicked = (event: MessageEvent) => {
      const worker = event.source as ServiceWorker | null;
      if (
        worker?.scriptURL === new URL('/notification-worker.js', window.location.origin).href &&
        event.origin === window.location.origin &&
        event.data?.type === 'covro-notification-click'
      )
        navigate(event.data.url);
    };
    navigator.serviceWorker?.addEventListener('message', clicked);
    window.addEventListener('hashchange', fromURL);
    fromURL();
    window.addEventListener('storage', sync);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      navigator.serviceWorker?.removeEventListener('message', clicked);
      window.removeEventListener('hashchange', fromURL);
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    if (!destination || !options.navigationReady) return;
    setDestination(undefined);
    if (latest.current.projectName(destination.projectId))
      latest.current.openThread(destination.threadId, destination.projectId, destination.target);
  }, [destination, options.navigationReady]);

  useEffect(() => {
    let active = true;
    setReady(false);
    if (!enabled || access !== 'granted') {
      setInitializing(false);
      return;
    }
    setInitializing(true);
    void prepareNotificationDelivery()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((problem: unknown) => {
        if (active) deliveryError(problem);
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, access, deliveryError]);

  const toggle = async () => {
    if (requestInFlight.current) return;
    setError(undefined);
    setTestResult(undefined);
    const current = notificationAccess();
    setAccess(current);
    if (enabled) {
      try {
        localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '0');
        setEnabled(false);
      } catch {
        setError(
          message('notifications:cannot_save_notification_settings_allow_browser_storage_for'),
        );
      }
      return;
    }
    if (!['default', 'granted'].includes(current)) return;
    requestInFlight.current = true;
    setRequesting(true);
    try {
      // Called directly from the user's click, before any asynchronous work.
      const permission = current === 'default' ? await Notification.requestPermission() : current;
      if (!mounted.current) return;
      setAccess(permission);
      if (permission === 'granted') {
        await prepareNotificationDelivery();
        if (!mounted.current) return;
        if (notificationAccess() !== 'granted') throw new NotificationDeliveryError('permission');
        localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
        setEnabled(true);
      }
    } catch (problem) {
      if (problem instanceof NotificationDeliveryError) deliveryError(problem);
      else if (mounted.current)
        setError(
          message(
            'notifications:cannot_enable_notifications_check_notification_permissions_and_site',
          ),
        );
    } finally {
      requestInFlight.current = false;
      if (mounted.current) setRequesting(false);
    }
  };

  const show = useCallback(
    (title: string, options: NotificationOptions, destination?: NotificationDestination) =>
      showBrowserNotification(
        title,
        options,
        destination,
        () => {
          if (destination)
            latest.current.openThread(
              destination.threadId,
              destination.projectId,
              destination.target,
            );
        },
        deliveryError,
        () =>
          mounted.current &&
          notificationsEnabled() &&
          notificationAccess() === 'granted' &&
          (!destination || Boolean(latest.current.projectName(destination.projectId))),
      ),
    [deliveryError],
  );

  const notify = useCallback(
    async (completion: TurnCompletion) => {
      if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
      const projectName = latest.current.projectName(scopeKey(completion.projectId));
      if (!projectName) return;
      try {
        await prepareNotificationDelivery();
        if (!(await claimCompletion(completion.threadId, completion.turnId))) return;
        // The user may disable notifications or remove the project while the claim is pending.
        if (
          !mounted.current ||
          !notificationsEnabled() ||
          notificationAccess() !== 'granted' ||
          !latest.current.projectName(scopeKey(completion.projectId))
        )
          return;
        const message = completionNotification(completion, projectName);
        await show(message.title, message.options, {
          threadId: completion.threadId,
          projectId: scopeKey(completion.projectId),
        });
      } catch (problem) {
        if (problem instanceof NotificationDeliveryError) deliveryError(problem);
        else if (mounted.current)
          setError(
            message('notifications:cannot_show_notifications_or_save_deduplication_records_check'),
          );
      }
    },
    [show, deliveryError],
  );

  const test = async () => {
    if (testing || !notificationsEnabled() || notificationAccess() !== 'granted') return;
    setError(undefined);
    setTestResult(undefined);
    setTesting(true);
    try {
      const sent = await show(t('notifications:test_notification'), {
        body: t('notifications:test_description'),
      });
      if (sent && mounted.current) setTestResult(message('notifications:test_submitted'));
    } catch (problem) {
      deliveryError(problem);
    } finally {
      if (mounted.current) setTesting(false);
    }
  };

  const notifyAttention = useCallback(
    async (request: AttentionRequest) => {
      if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
      const project = scopeKey(request.projectId);
      if (!latest.current.projectName(project)) return;
      try {
        // Installation can be slow. Arbitrate and revalidate requests only once delivery is ready.
        await prepareNotificationDelivery();
        if (!(await claimNotification(attentionKey(request)))) return;
        // Revalidate after asynchronous arbitration: another tab may already have responded.
        const pending = await api.threadAttention(request.threadId);
        if (!pending.some((entry) => attentionKey(entry) === attentionKey(request))) return;
        const name = latest.current.projectName(project);
        if (
          !mounted.current ||
          !name ||
          !notificationsEnabled() ||
          notificationAccess() !== 'granted'
        )
          return;
        const notification = attentionNotification(request, name);
        await show(notification.title, notification.options, {
          threadId: request.threadId,
          projectId: project,
          target: request.target,
        });
      } catch (problem) {
        if (problem instanceof NotificationDeliveryError) deliveryError(problem);
        else if (mounted.current)
          setError(
            message('notifications:cannot_show_notifications_or_save_deduplication_records_check'),
          );
      }
    },
    [show, deliveryError],
  );

  return {
    enabled,
    access,
    requesting,
    error,
    ready,
    initializing,
    testing,
    testResult,
    toggle,
    test,
    notify,
    notifyAttention,
  };
}

export type BrowserNotifications = ReturnType<typeof useBrowserNotifications>;

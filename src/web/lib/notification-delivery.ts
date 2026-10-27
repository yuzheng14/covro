import { notificationURL, type NotificationDestination } from './notification-navigation';

export class NotificationDeliveryError extends Error {
  constructor(
    readonly reason: 'initialization' | 'unsupported' | 'permission' | 'delivery',
    cause?: unknown,
  ) {
    super(`Notification ${reason} failed`, { cause });
  }
}

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

function bounded<T>(pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Notification registration timed out')),
      10_000,
    );
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function activated(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active?.state === 'activated') return Promise.resolve();
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return Promise.reject(new Error('No notification worker'));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Notification worker failed'));
    };
    const timer = setTimeout(() => finish(new Error('Notification worker timed out')), 10_000);
    worker.addEventListener('statechange', changed);
    changed();
  });
}

/** Register only after opt-in. No fetch handler, page caching, or Web Push is installed. */
export function prepareNotificationDelivery(): Promise<ServiceWorkerRegistration | undefined> {
  if (!navigator.serviceWorker) return Promise.resolve(undefined);
  if (!registration) {
    registration = (async () => {
      const worker = await bounded(
        navigator.serviceWorker.register('/notification-worker.js', {
          updateViaCache: 'none',
        }),
      );
      await activated(worker);
      if (typeof worker.showNotification !== 'function')
        throw new NotificationDeliveryError('unsupported');
      return worker;
    })().catch((error: unknown) => {
      registration = undefined; // A later explicit attempt can recover from a temporary failure.
      throw error instanceof NotificationDeliveryError
        ? error
        : new NotificationDeliveryError('initialization', error);
    });
  }
  return registration;
}

export async function showBrowserNotification(
  title: string,
  options: NotificationOptions,
  destination: NotificationDestination | undefined,
  onClick: () => void,
  onError: (error: NotificationDeliveryError) => void,
  canShow: () => boolean,
): Promise<boolean> {
  const worker = await prepareNotificationDelivery();
  if (!canShow()) return false;
  if (Notification.permission !== 'granted') throw new NotificationDeliveryError('permission');
  try {
    if (worker) {
      await worker.showNotification(title, {
        ...options,
        data: { type: 'covro-notification', url: notificationURL(destination) },
      });
    } else {
      // Desktop browsers without Service Workers retain their non-persistent notification path.
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
      notification.onerror = () => onError(new NotificationDeliveryError('delivery'));
    }
    return true;
  } catch (error) {
    throw new NotificationDeliveryError(
      !worker && error instanceof TypeError ? 'unsupported' : 'delivery',
      error,
    );
  }
}

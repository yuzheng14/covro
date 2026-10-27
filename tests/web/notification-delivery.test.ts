import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const destination = { threadId: 'thread', projectId: 'project' };

function environment() {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const worker = { active: { state: 'activated' }, showNotification };
  const register = vi.fn().mockResolvedValue(worker);
  const constructor = vi.fn(function (): { onclick?: () => void; close: () => void } {
    throw new TypeError('Illegal constructor. Use ServiceWorkerRegistration.showNotification()');
  });
  Object.assign(constructor, { permission: 'granted' });
  vi.stubGlobal('navigator', { serviceWorker: { register } });
  vi.stubGlobal('Notification', constructor);
  return { showNotification, worker, register, constructor };
}

it('uses persistent notifications when the granted Notification constructor is unusable', async () => {
  const { showNotification, register, constructor } = environment();
  const { showBrowserNotification } = await import('../../src/web/lib/notification-delivery');
  await expect(
    showBrowserNotification(
      '完成',
      { body: '项目 · 会话' },
      destination,
      vi.fn(),
      vi.fn(),
      () => true,
    ),
  ).resolves.toBe(true);
  expect(constructor).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledWith('/notification-worker.js', { updateViaCache: 'none' });
  expect(showNotification).toHaveBeenCalledWith('完成', {
    body: '项目 · 会话',
    data: {
      type: 'covro-notification',
      url: '/#notification=' + encodeURIComponent(JSON.stringify(destination)),
    },
  });
});

it('shares registration work and allows retry after initialization fails', async () => {
  const { register } = environment();
  register.mockRejectedValueOnce(new Error('Worker blocked'));
  const { prepareNotificationDelivery } = await import('../../src/web/lib/notification-delivery');
  const first = prepareNotificationDelivery();
  expect(prepareNotificationDelivery()).toBe(first);
  await expect(first).rejects.toMatchObject({ reason: 'initialization' });
  await expect(prepareNotificationDelivery()).resolves.toBeDefined();
  expect(register).toHaveBeenCalledTimes(2);
});

it('waits for worker activation and bounds initialization time', async () => {
  vi.useFakeTimers();
  const { register, worker } = environment();
  register.mockResolvedValue({
    ...worker,
    active: null,
    installing: { state: 'installing', addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  const { prepareNotificationDelivery } = await import('../../src/web/lib/notification-delivery');
  const pending = expect(prepareNotificationDelivery()).rejects.toMatchObject({
    reason: 'initialization',
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
});

it('also bounds a registration request that never settles', async () => {
  vi.useFakeTimers();
  const { register } = environment();
  register.mockReturnValue(new Promise(() => {}));
  const { prepareNotificationDelivery } = await import('../../src/web/lib/notification-delivery');
  const pending = expect(prepareNotificationDelivery()).rejects.toMatchObject({
    reason: 'initialization',
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
});

it('rechecks permission and the enabled preference after asynchronous preparation', async () => {
  const { showNotification } = environment();
  const { showBrowserNotification } = await import('../../src/web/lib/notification-delivery');
  const show = (canShow: () => boolean) =>
    showBrowserNotification('完成', {}, destination, vi.fn(), vi.fn(), canShow);
  await expect(show(() => false)).resolves.toBe(false);
  vi.stubGlobal('Notification', { permission: 'denied' });
  await expect(show(() => true)).rejects.toMatchObject({ reason: 'permission' });
  expect(showNotification).not.toHaveBeenCalled();
});

it('reports persistent delivery rejection instead of falling back to the illegal constructor', async () => {
  const { showNotification, constructor } = environment();
  showNotification.mockRejectedValue(new Error('System notification unavailable'));
  const { showBrowserNotification } = await import('../../src/web/lib/notification-delivery');
  await expect(
    showBrowserNotification('完成', {}, destination, vi.fn(), vi.fn(), () => true),
  ).rejects.toMatchObject({ reason: 'delivery' });
  expect(constructor).not.toHaveBeenCalled();
});

it('keeps the desktop fallback and distinguishes an unsupported constructor', async () => {
  const { constructor } = environment();
  vi.stubGlobal('navigator', {});
  const { showBrowserNotification } = await import('../../src/web/lib/notification-delivery');
  await expect(
    showBrowserNotification('完成', {}, destination, vi.fn(), vi.fn(), () => true),
  ).rejects.toMatchObject({ reason: 'unsupported' });
  const notification = { onclick: undefined as (() => void) | undefined, close: vi.fn() };
  constructor.mockImplementation(function () {
    return notification;
  });
  const open = vi.fn();
  const focus = vi.fn();
  vi.stubGlobal('window', { focus });
  await showBrowserNotification('完成', {}, destination, open, vi.fn(), () => true);
  notification.onclick?.();
  expect(open).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
  expect(notification.close).toHaveBeenCalledOnce();
});

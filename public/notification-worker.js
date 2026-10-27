/* global self, URL */

// Notifications only: do not intercept requests or cache authenticated application content.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.type !== 'covro-notification' || typeof data.url !== 'string') return;
  let url;
  try {
    url = new URL(data.url, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== '/') return;
  } catch {
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const pages = windows.filter((client) => {
        const location = new URL(client.url);
        return location.origin === url.origin && location.pathname === '/';
      });
      const client = pages.find((page) => page.focused) ?? pages[0];
      if (client) {
        client.postMessage({ type: 'covro-notification-click', url: url.href });
        await client.focus();
      } else {
        await self.clients.openWindow(url.href);
      }
    })(),
  );
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { notificationURL, parseNotificationURL } from '../../src/web/lib/notification-navigation';

afterEach(() => vi.unstubAllGlobals());
const origin = 'https://covro.example';

it.each([undefined, { kind: 'action', id: 'request' }, { kind: 'question', id: '问题' }] as const)(
  'preserves project, conversation and optional request identifiers',
  (target) => {
    vi.stubGlobal('window', { location: { origin } });
    const destination = {
      threadId: 'thread/中文',
      projectId: 'project',
      ...(target && { target }),
    };
    expect(parseNotificationURL(notificationURL(destination))).toEqual(destination);
  },
);

it('rejects external navigation, unrelated paths and malformed identifiers', () => {
  vi.stubGlobal('window', { location: { origin } });
  for (const input of [
    undefined,
    '/#notification=%',
    '/#notification=null',
    '/#notification={}',
    'https://other.example' + notificationURL({ threadId: 'thread', projectId: 'project' }),
    '/api' + notificationURL({ threadId: 'thread', projectId: 'project' }),
    notificationURL({ threadId: '', projectId: 'project' }),
    '/#notification=' +
      encodeURIComponent(
        JSON.stringify({ threadId: 't', projectId: 'p', target: { kind: 'unknown', id: 'a' } }),
      ),
  ])
    expect(parseNotificationURL(input)).toBeUndefined();
});

function clickWorker(url: string, pages: object[] = []) {
  const handlers = new Map<string, (input: typeof event) => void>();
  const pending: Promise<void>[] = [];
  const event = {
    notification: { data: { type: 'covro-notification', url }, close: vi.fn() },
    waitUntil: (promise: Promise<void>) => pending.push(promise),
  };
  const clients = {
    matchAll: vi.fn().mockResolvedValue(pages),
    openWindow: vi.fn().mockResolvedValue(undefined),
  };
  runInNewContext(
    readFileSync(new URL('../../public/notification-worker.js', import.meta.url), 'utf8'),
    {
      URL,
      self: {
        location: { origin },
        clients,
        addEventListener: (type: string, handler: (input: typeof event) => void) =>
          handlers.set(type, handler),
      },
    },
  );
  handlers.get('notificationclick')!(event);
  return { event, clients, done: Promise.all(pending) };
}

it('focuses one existing app tab and sends the destination without reloading its drafts', async () => {
  const page = { url: origin + '/', focused: true, focus: vi.fn(), postMessage: vi.fn() };
  const other = { url: origin + '/api/private', focus: vi.fn(), postMessage: vi.fn() };
  const url = notificationURL({ threadId: 't', projectId: 'p' });
  const result = clickWorker(url, [other, page]);
  await result.done;
  expect(page.postMessage).toHaveBeenCalledWith({
    type: 'covro-notification-click',
    url: origin + url,
  });
  expect(page.focus).toHaveBeenCalledOnce();
  expect(other.focus).not.toHaveBeenCalled();
  expect(result.clients.openWindow).not.toHaveBeenCalled();
  expect(result.event.notification.close).toHaveBeenCalledOnce();
});

it('opens a destination URL when the original page has closed', async () => {
  const url = notificationURL({ threadId: 't', projectId: 'p' });
  const result = clickWorker(url);
  await result.done;
  expect(result.clients.openWindow).toHaveBeenCalledWith(origin + url);
});

it('does not open an external URL supplied by malformed notification data', async () => {
  const result = clickWorker('https://other.example/');
  await result.done;
  expect(result.clients.matchAll).not.toHaveBeenCalled();
  expect(result.clients.openWindow).not.toHaveBeenCalled();
});

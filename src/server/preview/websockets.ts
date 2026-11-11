import { WebSocketServer } from 'ws';
import type { PreviewProxy } from './proxy.js';
import type { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { nullLogger, type Logger } from '../../logging/logger.js';
import { errorFields } from '../../logging/fields.js';

/** OS checks await after HTTP detaches and before ws owns an upgrade. Cover
 * that gap without adding an upgrade listener: Hono uses that listener count
 * to decide whether it must send a rejected handshake. */
export function guardPreviewUpgrades(
  server: Pick<EventEmitter, 'prependListener'>,
  logger: Logger = nullLogger,
) {
  server.prependListener('connection', (socket: Duplex) => {
    socket.on('error', (error: Error) => {
      if (socket.listenerCount('error') !== 1) return;
      logger.debug('gateway.upgrade_transport_failed', {
        ...errorFields(error),
        reason: 'peer_disconnected',
      });
      socket.destroy();
    });
  });
}

/** Separate receivers preserve the management route's original 8 KiB limit. */
export function attachPreviewWebSockets(management: WebSocketServer, preview: PreviewProxy) {
  const options = {
    noServer: true,
    handleProtocols: (_protocols: Set<string>, request: object) =>
      preview.selectedProtocol(request),
  };
  const strict = new WebSocketServer({ ...options, maxPayload: 8192 });
  const full = new WebSocketServer({ ...options, maxPayload: 16 * 1024 * 1024 });
  const upgradeManagement = management.handleUpgrade.bind(management);
  management.handleUpgrade = (request, socket, head, callback) => {
    if (request.url?.startsWith('/preview/'))
      (preview.configuration().fullRequests ? full : strict).handleUpgrade(
        request,
        socket,
        head,
        callback,
      );
    else upgradeManagement(request, socket, head, callback);
  };
  for (const server of [strict, full])
    server.on('headers', (headers, request) => management.emit('headers', headers, request));
  return [strict, full];
}

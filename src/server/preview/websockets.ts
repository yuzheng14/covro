import { WebSocketServer } from 'ws';
import type { PreviewProxy } from './proxy.js';

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

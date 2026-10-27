import type { WSEvents, WSContext } from 'hono/ws';
import type { WebSocketLike } from '@hono/node-server';
import type { WebSocketServer, WebSocket } from 'ws';
import { socketMessageSchema } from '../shared/validation.js';
import type { ServerMessage, ThreadView } from '../shared/types.js';
import { AppError } from '../shared/errors.js';
import type { GatewayService } from './service.js';
import type { AppConfig } from './config.js';
import type { Identity } from './auth.js';
import { compactThreadForTransport } from './snapshot.js';

export interface SocketSink {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate?(): void;
}
/** Bounds both individual snapshots and queued bytes, including runtime broadcasts. */
export function sendBounded(socket: SocketSink, message: ServerMessage, limit: number): void {
  if (socket.readyState !== 1) return;
  let outgoing = message;
  const budget = Math.max(512, Math.floor(limit / 2));
  try {
    if (message.type === 'snapshot')
      outgoing = { ...message, data: compactThreadForTransport(message.data, budget) };
    else if (message.type === 'event' && message.kind === 'thread')
      outgoing = {
        ...message,
        payload: compactThreadForTransport(message.payload as ThreadView, budget),
      };
  } catch (error) {
    outgoing = {
      type: 'error',
      error:
        error instanceof AppError
          ? error.toJSON()
          : {
              code: 'SNAPSHOT_TOO_LARGE',
              message: 'Current control state exceeds the configured limit',
            },
    };
  }
  const encoded = JSON.stringify(outgoing);
  // Large item replacements use the lossless HTTP path; never clip their body.
  if (
    message.type === 'event' &&
    message.kind === 'threadPatch' &&
    Buffer.byteLength(encoded) > budget
  ) {
    sendBounded(
      socket,
      { type: 'resync', threadId: message.threadId!, cursor: message.cursor },
      limit,
    );
    return;
  }
  if (socket.bufferedAmount + Buffer.byteLength(encoded) > limit) {
    socket.close(4008, 'Slow connection; reconnect for snapshot');
    socket.terminate?.();
    return;
  }
  socket.send(encoded);
}
export function socketHandlers(
  service: GatewayService,
  config: AppConfig,
  identity: Identity,
  overview = false,
): WSEvents<WebSocketLike> {
  let unsubscribe: (() => void) | undefined;
  let stopRuntime: (() => void) | undefined;
  let stopOverview: (() => void) | undefined;
  let generation = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const send = (ws: WSContext<WebSocketLike>, message: ServerMessage) => {
    const raw = ws.raw as WebSocket | undefined;
    sendBounded(
      raw ?? {
        readyState: ws.readyState,
        bufferedAmount: 0,
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      },
      message,
      config.limits.wsBytes,
    );
  };
  return {
    onOpen(_event, ws) {
      stopRuntime = service.subscribeRuntime((message) => send(ws, message));
      if (overview) stopOverview = service.subscribeOverview((message) => send(ws, message));
      if (identity.expiresAt)
        expiry = setTimeout(
          () => ws.close(4001, 'Authentication expired'),
          Math.min(2_147_483_647, Math.max(1, identity.expiresAt - Date.now())),
        );
    },
    async onMessage(event, ws) {
      const current = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      const deliver = (message: ServerMessage) => {
        if (current === generation && !(message.type === 'event' && message.kind === 'runtime'))
          send(ws, message);
      };
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8192)
          throw new AppError('VALIDATION_FAILED', 'Invalid subscription');
        const input = socketMessageSchema.parse(JSON.parse(event.data));
        if (input.type === 'unsubscribe') return;
        const stop = await service.subscribe(
          input.threadId,
          input.after,
          deliver,
          input.incremental,
        );
        if (current !== generation || ws.readyState !== 1) stop();
        else unsubscribe = stop;
      } catch (error) {
        deliver({
          type: 'error',
          error:
            error instanceof AppError
              ? error.toJSON()
              : { code: 'VALIDATION_FAILED', message: 'Invalid subscription' },
        });
      }
    },
    onClose() {
      generation++;
      unsubscribe?.();
      stopRuntime?.();
      stopOverview?.();
      clearTimeout(expiry);
    },
    onError() {
      generation++;
      unsubscribe?.();
      stopRuntime?.();
      stopOverview?.();
      clearTimeout(expiry);
    },
  };
}
export function startHeartbeat(server: WebSocketServer): () => void {
  const alive = new WeakSet<WebSocket>();
  server.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => ws.terminate());
  });
  const timer = setInterval(() => {
    for (const ws of server.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 25_000);
  timer.unref();
  return () => clearInterval(timer);
}

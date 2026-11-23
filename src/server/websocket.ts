import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { logContext } from '../logging/context.js';
import type { WSEvents, WSContext } from 'hono/ws';
import type { WebSocketLike } from '@hono/node-server';
import type { WebSocketServer, WebSocket } from 'ws';
import { socketMessageSchema } from '../shared/validation.js';
import { MAX_THREAD_SUBSCRIPTIONS, type ServerMessage, type ThreadView } from '../shared/types.js';
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
export function sendBounded(
  socket: SocketSink,
  message: ServerMessage,
  limit: number,
  logger: Logger = nullLogger,
): void {
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
    logger.debug('websocket.resync_required', {
      threadId: message.threadId,
      receivedBytes: Buffer.byteLength(encoded),
      limitBytes: budget,
    });
    sendBounded(
      socket,
      {
        type: 'resync',
        threadId: message.threadId!,
        cursor: message.cursor,
        subscriptionId: message.subscriptionId,
      },
      limit,
      logger,
    );
    return;
  }
  if (socket.bufferedAmount + Buffer.byteLength(encoded) > limit) {
    logger.warn('websocket.buffer_exceeded', {
      bufferedBytes: socket.bufferedAmount,
      receivedBytes: Buffer.byteLength(encoded),
      limitBytes: limit,
    });
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
  logger: Logger = nullLogger,
): WSEvents<WebSocketLike> {
  logger = logger.child({ ...logContext(), connectionId: crypto.randomUUID() });
  const subscriptions = new Map<string, { stop?: () => void }>();
  const remove = (id: string) => {
    subscriptions.get(id)?.stop?.();
    subscriptions.delete(id);
  };
  const clear = () => {
    for (const id of subscriptions.keys()) remove(id);
  };
  let stopRuntime: (() => void) | undefined;
  let stopOverview: (() => void) | undefined;
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
      logger,
    );
  };
  return {
    onOpen(_event, ws) {
      logger.debug('websocket.connected');
      stopRuntime = service.subscribeRuntime((message) => send(ws, message));
      if (overview) stopOverview = service.subscribeOverview((message) => send(ws, message));
      if (identity.expiresAt)
        expiry = setTimeout(
          () => ws.close(4001, 'Authentication expired'),
          Math.min(2_147_483_647, Math.max(1, identity.expiresAt - Date.now())),
        );
    },
    async onMessage(event, ws) {
      let scoped: { threadId: string; subscriptionId: number } | undefined;
      let key: string | undefined;
      let slot: { stop?: () => void } | undefined;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8192)
          throw new AppError('VALIDATION_FAILED', 'Invalid subscription');
        const input = socketMessageSchema.parse(JSON.parse(event.data));
        if (input.type === 'unsubscribe') {
          if (input.threadId) remove(input.threadId);
          else clear();
          return;
        }
        if (input.subscriptionId !== undefined)
          scoped = { threadId: input.threadId, subscriptionId: input.subscriptionId };
        else clear(); // Preserve the legacy single-selection protocol.
        key = scoped ? input.threadId : '';
        remove(key);
        if (subscriptions.size >= MAX_THREAD_SUBSCRIPTIONS)
          throw new AppError('VALIDATION_FAILED', 'Too many thread subscriptions');
        slot = {};
        subscriptions.set(key, slot);
        const stop = await service.subscribe(
          input.threadId,
          input.after,
          (message) => {
            if (subscriptions.get(key!) !== slot) return;
            if (message.type === 'event' && message.kind === 'runtime') return;
            send(ws, scoped ? { ...message, subscriptionId: scoped.subscriptionId } : message);
          },
          scoped ? true : input.incremental,
          Boolean(scoped),
        );
        if (subscriptions.get(key) !== slot || ws.readyState !== 1) stop();
        else slot.stop = stop;
      } catch (error) {
        if (slot && key !== undefined) {
          if (subscriptions.get(key) !== slot) return;
          remove(key);
        }
        logger.warn('websocket.subscription_failed', {
          ...errorFields(error),
          threadId: scoped?.threadId,
        });
        send(ws, {
          type: 'error',
          ...scoped,
          ...(scoped ? { status: error instanceof AppError ? error.status : 400 } : {}),
          error:
            error instanceof AppError
              ? error.toJSON()
              : { code: 'VALIDATION_FAILED', message: 'Invalid subscription' },
        });
      }
    },
    onClose() {
      logger.debug('websocket.disconnected');
      clear();
      stopRuntime?.();
      stopOverview?.();
      clearTimeout(expiry);
    },
    onError() {
      logger.warn('websocket.failed');
      clear();
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

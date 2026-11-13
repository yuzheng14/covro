import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { request as httpRequest, Agent, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import type { WSEvents } from 'hono/ws';
import type { WebSocketLike } from '@hono/node-server';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { PreviewSettings } from '../../shared/dev-preview.js';
import type { Authenticator, Identity } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { PreviewDiscovery, RegisteredService } from './discovery.js';
import { nullLogger, type Logger } from '../../logging/logger.js';
import { errorFields } from '../../logging/fields.js';

export const previewSettingsSchema = z
  .object({ enabled: z.boolean(), fullRequests: z.boolean() })
  .strict();
const resourceTypes =
  /^(?:text\/(?:html|css|javascript)|application\/(?:javascript|x-javascript|wasm)|image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/[a-z0-9.+-]+|application\/(?:font-woff|vnd\.ms-fontobject))$/;
const destinations = new Set(['document', 'script', 'style', 'image', 'font', 'manifest']);
const MAX_BYTES = 16 * 1024 * 1024;
const relaySchema = z
  .object({
    url: z.string().max(8192),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    headers: z
      .record(z.string().max(256), z.string().max(8192))
      .refine((v) => Object.keys(v).length <= 64),
    body: z.string().max(MAX_BYTES).optional(),
  })
  .strict();
async function requestBytes(request: Request) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) reject('PREVIEW_BODY', 'Preview request exceeds 16 MiB', 413);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return Buffer.concat(chunks);
}
interface Grant {
  id: string;
  serviceId: string;
  subject?: string;
  origin: string;
  expires: number;
  stop: Set<() => void>;
}
export interface PreviewAdapter {
  forget?(prefix: string): void;
  transform(
    body: string,
    type: string,
    path: string,
    prefix: string,
    origin: string,
    load?: (path: string) => Promise<Response>,
  ): Promise<string>;
  hmr(
    path: string,
    protocols: string,
    prefix: string,
  ): { path: string; protocol: string } | undefined;
  hmrMessage(data: string, prefix: string): string | undefined;
}
const rawAdapter: PreviewAdapter = {
  transform: async (body) => body,
  hmr: () => undefined,
  hmrMessage: () => undefined,
};
function reject(code: string, message: string, status = 403): never {
  throw new AppError(code, message, status);
}

/** In-memory, per-open capabilities bind to a verified run and authenticated identity. */
export class PreviewProxy {
  private settings: PreviewSettings = { enabled: false, fullRequests: false };
  private readonly grants = new Map<string, Grant>();
  private saving = false;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private readonly protocols = new WeakMap<object, string>();
  private readonly expiry: ReturnType<typeof setInterval>;
  private readonly removeListener: () => void;
  constructor(
    readonly discovery: PreviewDiscovery,
    private readonly config: AppConfig,
    private readonly authenticate: Authenticator,
    private readonly adapter: PreviewAdapter = rawAdapter,
    private readonly logger: Logger = nullLogger,
  ) {
    this.removeListener = discovery.onWithdraw((id) => {
      for (const grant of this.grants.values()) if (grant.serviceId === id) this.revoke(grant);
    });
    this.expiry = setInterval(() => {
      for (const grant of this.grants.values()) if (Date.now() >= grant.expires) this.revoke(grant);
    }, 1000);
    this.expiry.unref();
  }
  async load() {
    try {
      this.settings = previewSettingsSchema.parse(
        JSON.parse(await readFile(join(this.config.dataDir, 'preview-settings.json'), 'utf8')),
      );
    } catch {
      /* New installations, old configurations and invalid files default closed. */
    }
  }
  configuration() {
    return { ...this.settings };
  }
  async configure(input: unknown) {
    if (this.closed) reject('PREVIEW_CLOSED', 'Preview proxy is shutting down', 503);
    const next = previewSettingsSchema.parse(input);
    if (!next.enabled) next.fullRequests = false;
    if (this.saving) reject('PREVIEW_SETTINGS_BUSY', 'Preview settings are being saved', 409);
    this.saving = true;
    // Narrowing is effective before any filesystem await, including failed persistence.
    if (!next.enabled || !next.fullRequests) {
      this.settings = {
        enabled: this.settings.enabled && next.enabled,
        fullRequests: this.settings.fullRequests && next.fullRequests,
      };
      this.revokeAll();
    }
    const path = join(this.config.dataDir, 'preview-settings.json');
    try {
      await mkdir(this.config.dataDir, { recursive: true });
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
      if (this.closed) reject('PREVIEW_CLOSED', 'Preview proxy is shutting down', 503);
      this.revokeAll();
      this.settings = next;
      this.logger.info('preview.policy_changed', {
        state: next.enabled ? (next.fullRequests ? 'full' : 'strict') : 'disabled',
      });
      return this.configuration();
    } catch (error) {
      this.logger.warn('preview.policy_failed', errorFields(error));
      throw error;
    } finally {
      this.saving = false;
    }
  }
  async open(serviceId: string, identity: Identity, entryOrigin = this.config.publicOrigin[0]!) {
    if (!this.settings.enabled) reject('PREVIEW_DISABLED', 'Development preview proxy is disabled');
    await this.discovery.verify(serviceId);
    if (![...this.config.publicOrigin, ...this.config.developmentOrigins].includes(entryOrigin))
      reject('PREVIEW_ENTRY', 'Preview entry is not a configured origin');
    if (!this.settings.enabled || this.grants.size >= 128)
      reject('PREVIEW_UNAVAILABLE', 'Preview access is unavailable');
    const grant: Grant = {
      id: randomBytes(32).toString('base64url'),
      serviceId,
      subject: identity.subject,
      origin: entryOrigin,
      expires: Math.min(Date.now() + 60 * 60_000, identity.expiresAt ?? Infinity),
      stop: new Set(),
    };
    this.grants.set(grant.id, grant);
    this.logger.info('preview.opened', { state: this.settings.fullRequests ? 'full' : 'strict' });
    return { url: `/preview/${grant.id}/`, expiresAt: grant.expires };
  }
  private revoke(grant: Grant) {
    this.logger.debug('preview.revoked', { reason: 'capability_withdrawn' });
    this.grants.delete(grant.id);
    this.adapter.forget?.(`/preview/${grant.id}/`);
    for (const stop of grant.stop) {
      try {
        stop();
      } catch {
        /* Continue revoking every other connection. */
      }
    }
    grant.stop.clear();
  }
  private revokeAll() {
    for (const grant of this.grants.values()) this.revoke(grant);
  }
  private active(grant: Grant) {
    if (
      !this.settings.enabled ||
      this.grants.get(grant.id) !== grant ||
      Date.now() >= grant.expires
    )
      reject('PREVIEW_WITHDRAWN', 'Preview access has expired or been withdrawn', 410);
  }
  private async authorize(request: Request) {
    const url = new URL(request.url);
    const match = /^\/preview\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(url.pathname);
    const grant = match ? this.grants.get(match[1]!) : undefined;
    if (!grant) reject('PREVIEW_WITHDRAWN', 'Preview access has expired or been withdrawn', 410);
    this.active(grant);
    if ((request.headers.get('host') ?? url.host) !== new URL(grant.origin).host)
      reject('PREVIEW_ENTRY', 'Reopen this preview from the current Covro entry');
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null' && origin !== grant.origin)
      reject('INVALID_ORIGIN', 'Invalid preview request origin');
    // Separate route authorization, after capability lookup. Management authentication
    // remains unchanged and still rejects Origin:null. null is never an identity.
    const headers = new Headers();
    for (const name of ['host', 'cf-access-jwt-assertion']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const identity = await this.authenticate(new Request(request.url, { headers }));
    grant.expires = Math.min(grant.expires, identity.expiresAt ?? Infinity);
    if (identity.subject !== grant.subject)
      reject('PREVIEW_IDENTITY', 'Preview belongs to a different identity');
    const run = await this.discovery.verify(grant.serviceId);
    this.active(grant);
    const path = match![2]! + url.search;
    // URL parsing normalizes dot segments before routing. Reject encoded separators,
    // nested authorities and control bytes before sending a request upstream.
    if (/%(?:2f|5c|00|0a|0d)/i.test(path) || path.startsWith('//') || path.includes('\\'))
      reject('PREVIEW_PATH', 'Invalid preview resource path');
    return { grant, run, path, prefix: `/preview/${grant.id}/`, origin: grant.origin };
  }
  private async socket(run: RegisteredService, grant: Grant): Promise<Socket> {
    if (this.sockets.size >= 128 || grant.stop.size >= 64)
      reject('PREVIEW_CONNECTION_LIMIT', 'Too many active preview connections', 429);
    const socket = connect({ host: run.host, port: run.port });
    this.sockets.add(socket);
    const stop = () => socket.destroy();
    grant.stop.add(stop);
    socket.once('close', () => {
      grant.stop.delete(stop);
      this.sockets.delete(socket);
    });
    try {
      await new Promise<void>((resolve, fail) => {
        socket.once('connect', resolve);
        socket.once('error', fail);
        socket.setTimeout(5000, () => socket.destroy(new Error('Preview connection timed out')));
      });
      // Check the accepted connection before sending HTTP bytes. This closes the
      // check/connect port-reuse race; a listener snapshot alone is insufficient.
      let confirmed = false;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        confirmed = await this.discovery.inspector!.connected(
          run.process.pid,
          run.port,
          socket.localPort!,
          run.host,
        );
        if (!confirmed) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!confirmed) reject('PREVIEW_OWNER', 'Cannot verify the connected service process');
      const current = await this.discovery.verify(run.id);
      if (current.process.birth !== run.process.birth)
        reject('PREVIEW_OWNER', 'Service process changed');
      this.active(grant);
      socket.setTimeout(0);
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  private headers(prefix: string, origin: string) {
    const allowed = new URL(prefix, origin).href;
    const ws = allowed.replace(/^http/, 'ws');
    return new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'X-Covro-Redirect, X-Covro-Redirect-Status, Content-Type',
      Vary: 'Origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${allowed}; style-src 'unsafe-inline' ${allowed}; img-src data: blob: ${allowed}; font-src data: ${allowed}; connect-src ${allowed} ${ws}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
  }
  async handle(request: Request): Promise<Response> {
    const { grant, run, prefix, origin, path: initialPath } = await this.authorize(request);
    let path = initialPath;
    let method = request.method;
    let incomingHeaders = request.headers;
    const full = this.settings.fullRequests;
    if (!full && !['GET', 'HEAD'].includes(request.method))
      reject('PREVIEW_METHOD', 'Strict preview only allows GET and HEAD', 405);
    if (
      !full &&
      request.headers.get('sec-fetch-dest') &&
      !destinations.has(request.headers.get('sec-fetch-dest')!)
    )
      reject('PREVIEW_REQUEST', 'Strict preview does not allow application requests');
    if (['CONNECT', 'TRACE'].includes(request.method))
      reject('PREVIEW_METHOD', 'Unsupported preview method', 405);
    if (request.headers.get('range'))
      reject('PREVIEW_RANGE', 'Partial preview responses are unsupported', 416);
    const relay = path === '/__covro_request';
    let body: Buffer | undefined;
    if (relay) {
      if (
        !full ||
        method !== 'POST' ||
        request.headers.get('content-type')?.split(';')[0] !== 'text/plain'
      )
        reject('PREVIEW_RELAY', 'Application relay requires full request mode');
      const input = relaySchema.parse(JSON.parse((await requestBytes(request)).toString('utf8')));
      const target = new URL(input.url);
      if (
        target.origin !== origin ||
        !target.pathname.startsWith(prefix) ||
        target.username ||
        target.password
      )
        reject('PREVIEW_RELAY', 'Application relay target must belong to this preview run');
      path = target.pathname.slice(prefix.length - 1) + target.search;
      if (
        path.startsWith('//') ||
        /%(?:2f|5c|00|0a|0d)/i.test(path) ||
        path.includes('\\') ||
        path.split('?')[0] === '/__covro_request'
      )
        reject('PREVIEW_RELAY', 'Invalid application relay path');
      method = input.method;
      incomingHeaders = new Headers(input.headers);
      if (input.body && !['GET', 'HEAD'].includes(method)) body = Buffer.from(input.body, 'base64');
    } else if (!['GET', 'HEAD'].includes(method)) body = await requestBytes(request);
    const headers = this.headers(prefix, origin);
    const upstreamHeaders: Record<string, string> = {
      host: `${run.host === '::1' ? '[::1]' : run.host}:${run.port}`,
      'accept-encoding': 'identity',
    };
    // Positive allowlist: no Cookie, Authorization, Access/forwarded credentials,
    // client-controlled Host/Origin or hop-by-hop headers can reach the project.
    for (const name of ['accept', 'accept-language', 'content-type']) {
      const value = incomingHeaders.get(name);
      if (value) upstreamHeaders[name] = value;
    }
    if (full) upstreamHeaders.origin = `http://${upstreamHeaders.host}`;
    if (relay) {
      // Explicit application headers come from the isolated application's Request,
      // never from automatic browser/Access authentication on the outer envelope.
      const management = new Set(
        [
          request.headers.get('authorization'),
          request.headers.get('cf-access-jwt-assertion'),
        ].filter(Boolean),
      );
      for (const [name, value] of incomingHeaders) {
        if (
          /^(?:cookie2?|host|origin|forwarded|connection|keep-alive|transfer-encoding|content-length|te|trailer|upgrade|accept-encoding|proxy-.*|cf-.*|sec-.*|x-forwarded-.*|access-control-.*)$/i.test(
            name,
          ) ||
          management.has(value)
        )
          continue;
        upstreamHeaders[name] = value;
      }
    }
    if (body && body.length > MAX_BYTES)
      reject('PREVIEW_BODY', 'Preview request exceeds 16 MiB', 413);
    const socket = await this.socket(run, grant);
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const response = await new Promise<IncomingMessage>((resolve, fail) => {
      const outgoing = httpRequest(
        {
          host: run.host,
          port: run.port,
          path,
          method,
          agent,
          headers: upstreamHeaders,
        },
        resolve,
      );
      outgoing.once('error', fail);
      request.signal.addEventListener('abort', () => outgoing.destroy(), { once: true });
      outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Preview response timed out')));
      outgoing.end(body);
    }).catch((error) => {
      socket.destroy();
      agent.destroy();
      throw error;
    });
    const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    const status = response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.destroy();
      if (!location) reject('PREVIEW_REDIRECT', 'Invalid preview redirect');
      const target = new URL(location, `http://${upstreamHeaders.host}${path}`);
      if (target.origin !== `http://${upstreamHeaders.host}`)
        reject('PREVIEW_REDIRECT', 'External preview redirects are blocked');
      headers.set(
        'Location',
        prefix + target.pathname.replace(/^\//, '') + target.search + target.hash,
      );
      if (relay) {
        headers.set('X-Covro-Redirect', headers.get('Location')!);
        headers.set('X-Covro-Redirect-Status', String(status));
        headers.delete('Location');
        return new Response(null, { status: 200, headers });
      }
      return new Response(null, { status, headers });
    }
    if (!full && !resourceTypes.test(type)) {
      response.destroy();
      reject('PREVIEW_TYPE', 'Strict preview blocked a non-resource response');
    }
    if (
      response.headers['content-encoding'] &&
      response.headers['content-encoding'] !== 'identity'
    ) {
      response.destroy();
      reject('PREVIEW_ENCODING', 'Compressed upstream preview responses are unsupported', 502);
    }
    headers.set('Content-Type', response.headers['content-type'] ?? 'application/octet-stream');
    if (method === 'HEAD' || status === 204 || status === 304) {
      response.destroy();
      return new Response(null, { status: status === 304 ? 200 : status, headers });
    }
    if (
      !relay &&
      /^(?:text\/(?:html|css|javascript)|application\/(?:javascript|x-javascript))$/.test(type)
    ) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) {
          response.destroy();
          reject('PREVIEW_SIZE', 'Preview resource exceeds 16 MiB', 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      this.active(grant);
      const transformed = await this.adapter.transform(
        Buffer.concat(chunks).toString('utf8'),
        type,
        path,
        prefix,
        origin,
        (resource) =>
          this.handle(new Request(new URL(resource, origin), { headers: request.headers })),
      );
      this.active(grant);
      if (Buffer.byteLength(transformed) > MAX_BYTES)
        reject('PREVIEW_SIZE', 'Adapted preview resource exceeds 16 MiB', 413);
      return new Response(transformed, { status, headers });
    }
    return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
      status,
      headers,
    });
  }
  selectedProtocol(incoming: object) {
    return this.protocols.get(incoming) || false;
  }
  async websocket(request: Request, incoming?: object): Promise<WSEvents<WebSocketLike>> {
    const { grant, run, path, prefix } = await this.authorize(request);
    const full = this.settings.fullRequests;
    const hmr = this.adapter.hmr(path, request.headers.get('sec-websocket-protocol') ?? '', prefix);
    if (!full && !hmr)
      reject('PREVIEW_WEBSOCKET', 'Strict preview only allows controlled Vite HMR');
    const socket = await this.socket(run, grant);
    const target = `ws://${run.host === '::1' ? '[::1]' : run.host}:${run.port}${hmr?.path ?? path}`;
    const protocols = hmr
      ? [hmr.protocol]
      : (request.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    const upstream = new WebSocket(target, protocols, {
      createConnection: () => socket,
      maxPayload: MAX_BYTES,
      followRedirects: false,
      headers: { origin: `http://${run.host === '::1' ? '[::1]' : run.host}:${run.port}` },
    });
    const pending: { data: Buffer; binary: boolean }[] = [];
    upstream.on('message', (data, binary) => {
      if (pending.length < 32) pending.push({ data: Buffer.from(data as Buffer), binary });
      else upstream.terminate();
    });
    await new Promise<void>((resolve, fail) => {
      upstream.once('open', resolve);
      upstream.once('error', fail);
    });
    this.active(grant);
    if (incoming) this.protocols.set(incoming, upstream.protocol);
    let stop = () => upstream.terminate();
    const revoke = () => stop();
    grant.stop.add(revoke);
    upstream.once('close', () => grant.stop.delete(revoke));
    return {
      onOpen: (_event, client) => {
        stop = () => {
          upstream.terminate();
          client.close(1008, 'Preview access withdrawn');
          (client.raw as WebSocket | undefined)?.terminate();
        };
        const send = ({ data, binary }: { data: Buffer; binary: boolean }) => {
          if (this.grants.get(grant.id) !== grant || Date.now() >= grant.expires) {
            stop();
            return;
          }
          if (client.readyState !== 1) return;
          if (
            ((client.raw as WebSocket | undefined)?.bufferedAmount ?? 0) + data.length >
            MAX_BYTES
          ) {
            stop();
            return;
          }
          if (full) {
            const raw = client.raw as WebSocket | undefined;
            if (raw) raw.send(data, { binary });
            else client.send(binary ? Uint8Array.from(data) : data.toString());
          } else if (!binary) {
            const message = this.adapter.hmrMessage(data.toString(), prefix);
            if (message !== undefined) client.send(message);
          }
        };
        const handler = (data: Buffer, binary: boolean) => send({ data, binary });
        upstream.removeAllListeners('message');
        upstream.on('message', handler);
        pending.forEach(send);
        pending.length = 0;
        upstream.on('close', () => client.close());
        upstream.on('error', () => client.close(1011, 'Preview upstream failed'));
      },
      onMessage: (event) => {
        if (this.grants.get(grant.id) !== grant || Date.now() >= grant.expires) {
          stop();
          return;
        }
        if (upstream.readyState !== WebSocket.OPEN) return;
        const bytes =
          typeof event.data === 'string'
            ? Buffer.byteLength(event.data)
            : event.data instanceof Blob
              ? event.data.size
              : event.data.byteLength;
        if (upstream.bufferedAmount + bytes > MAX_BYTES) {
          stop();
          return;
        }
        if (full) {
          upstream.send(event.data as string);
          return;
        }
        try {
          const value = JSON.parse(String(event.data));
          if (value.type === 'ping') upstream.send('{"type":"ping"}');
          else if (
            value.type === 'custom' &&
            value.event === 'vite:invalidate' &&
            typeof value.data?.path === 'string' &&
            /^\/(?!\/)[^\0]{0,4096}$/.test(value.data.path) &&
            (value.data.message === undefined ||
              (typeof value.data.message === 'string' && value.data.message.length <= 4096)) &&
            (value.data.firstInvalidatedBy === undefined ||
              (typeof value.data.firstInvalidatedBy === 'string' &&
                /^\/(?!\/)[^\0]{0,4096}$/.test(value.data.firstInvalidatedBy)))
          )
            upstream.send(
              JSON.stringify({
                type: 'custom',
                event: 'vite:invalidate',
                data: {
                  path: value.data.path,
                  message: value.data.message,
                  firstInvalidatedBy: value.data.firstInvalidatedBy,
                },
              }),
            );
          else upstream.close(1008, 'Unsupported HMR message');
        } catch {
          upstream.close(1008, 'Unsupported HMR message');
        }
      },
      onClose() {
        upstream.terminate();
      },
      onError() {
        upstream.terminate();
      },
    };
  }
  close() {
    this.closed = true;
    this.settings.enabled = false;
    this.revokeAll();
    clearInterval(this.expiry);
    this.removeListener();
    this.discovery.close();
  }
}

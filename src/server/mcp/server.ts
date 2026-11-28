import { nullLogger, type Logger } from '../../logging/logger.js';
import { errorFields } from '../../logging/fields.js';
import { withLogContext } from '../../logging/context.js';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GatewayService } from '../service.js';
import {
  SessionLoopTools,
  createLoopInput,
  listLoopsInput,
  updateLoopInput,
} from './loop-tools.js';
import { CovroTools, createSessionInput, listProjectsInput } from './tools.js';

const instructions =
  'Use list_projects to confirm the target project directory, then create_session to start a Covro conversation with its required first prompt. Use Covro for session creation instead of starting another app-server. A submitted prompt is not a completed task. Reuse request_key with identical input to inspect an existing operation; never create a new key to automatically retry an unknown outcome.';

function protocolServer(
  service: GatewayService,
  origin: string,
  managed: boolean,
  logger: Logger,
): McpServer {
  const server = new McpServer({ name: 'covro', version: '1.0.0' }, { instructions });
  const tools = new CovroTools(service, origin);
  server.registerTool(
    'list_projects',
    {
      description:
        'List Covro-registered projects and their canonical directories and availability. Confirm the correct project_id before creating a session.',
      inputSchema: listProjectsInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input) => ({ ...tools.listProjects(input) }),
  );
  server.registerTool(
    'create_session',
    {
      description:
        "Create a conversation in the selected Covro project and immediately submit its required first prompt using Covro's managed app-server. Returns a submission receipt, not the task result. Reuse the returned request_key with identical arguments to inspect a previous operation without repeating its effects.",
      inputSchema: createSessionInput,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input, extra) => ({ ...(await tools.createSession(input, extra._meta)) }),
  );
  if (managed) {
    const loops = new SessionLoopTools(service, logger);
    server.registerTool(
      'list_loops',
      {
        description:
          'List loops belonging to this Covro session, including versions, status and next run time.',
        inputSchema: listLoopsInput,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      (input, extra) => loops.invoke({ tool: 'list_loops', input }, extra._meta, extra.signal),
    );
    server.registerTool(
      'create_loop',
      {
        description:
          'Create a loop in this Covro session. Specify a fixed interval in minutes or omit it for adaptive scheduling. The first run waits for the session to be idle.',
        inputSchema: createLoopInput,
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      (input, extra) => loops.invoke({ tool: 'create_loop', input }, extra._meta, extra.signal),
    );
    server.registerTool(
      'update_loop',
      {
        description:
          'Pause, resume, cancel or set the interval for a loop in this session. Use the version from list_loops. A new interval changes the fixed cadence or the next check of an adaptive loop. The current turn continues.',
        inputSchema: updateLoopInput,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      (input, extra) => loops.invoke({ tool: 'update_loop', input }, extra._meta, extra.signal),
    );
  }
  return server;
}

/** A local-only listener, deliberately separate from browser/tunnel authentication and routes. */
export async function startManagedMcp(options: {
  service: () => GatewayService | undefined;
  publicOrigin: string;
  logger?: Logger;
}) {
  const active = new Set<McpServer>();
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let closing = false;
  let origin = '';
  const http = createServer((request, response) => {
    const requestId = randomUUID();
    const logger = (options.logger ?? nullLogger).child({ requestId, component: 'mcp' });
    const started = performance.now();
    response.once('finish', () =>
      logger[response.statusCode >= 400 ? 'warn' : 'debug']('mcp.completed', {
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    const reject = (status: number, message: string) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
    };
    if (closing) return reject(503, 'Gateway stopping');
    if (request.headers.host !== new URL(origin).host) return reject(403, 'Invalid Host');
    if (request.headers.origin && request.headers.origin !== origin)
      return reject(403, 'Invalid Origin');
    if (request.url !== '/mcp') return reject(404, 'Not found');
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return reject(405, 'Method not allowed');
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return reject(415, 'Expected application/json');
    if (active.size >= 128) return reject(503, 'Too many MCP requests');
    const service = options.service();
    if (!service) return reject(503, 'Gateway not ready');
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const managed =
      authorization.length === expected.length && timingSafeEqual(authorization, expected);
    const server = protocolServer(service, options.publicOrigin, managed, logger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 512 * 1024,
    });
    active.add(server);
    response.once('close', () => {
      active.delete(server);
      void server.close().catch(() => {
        /* The client may already have disconnected. */
      });
    });
    void withLogContext({ requestId }, async () => {
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        logger.error('mcp.failed', errorFields(error));
        if (!response.headersSent) reject(500, 'MCP request failed');
        else response.end();
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve);
    http.once('error', reject);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected managed MCP TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
  let closed: Promise<void> | undefined;
  return {
    name: `covro_${randomUUID().replaceAll('-', '')}`,
    url: `${origin}/mcp`,
    token,
    close: () =>
      (closed ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve) => http.close(() => resolve()));
        http.closeAllConnections();
        await Promise.allSettled([...active].map((server) => server.close()));
        await stopped;
      })()),
  };
}

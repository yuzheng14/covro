import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GatewayService } from '../service.js';
import { CovroTools, createSessionInput, listProjectsInput } from './tools.js';

const instructions =
  'Use list_projects to confirm the target project directory, then create_session to start a Covro conversation with its required first prompt. Use Covro for session creation instead of starting another app-server. A submitted prompt is not a completed task. Reuse request_key with identical input to inspect an existing operation; never create a new key to automatically retry an unknown outcome.';

function protocolServer(service: GatewayService, origin: string): McpServer {
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
  return server;
}

/** A local-only listener, deliberately separate from browser/tunnel authentication and routes. */
export async function startManagedMcp(options: {
  service: () => GatewayService | undefined;
  publicOrigin: string;
}) {
  const active = new Set<McpServer>();
  let closing = false;
  let origin = '';
  const http = createServer((request, response) => {
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
    const server = protocolServer(service, options.publicOrigin);
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
    void (async () => {
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch {
        if (!response.headersSent) reject(500, 'MCP request failed');
        else response.end();
      }
    })();
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

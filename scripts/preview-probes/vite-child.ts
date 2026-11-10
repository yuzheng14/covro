/** Disposable Vite fixture, never imported by production. */
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
const root = process.argv[2]!;
const tag = process.argv[3]!;
const business = new WebSocketServer({ noServer: true });
business.on('connection', (ws) =>
  ws.on('message', (message, binary) => ws.send(message, { binary })),
);
const server = await createServer({
  root,
  configFile: false,
  cacheDir: root + '/cache',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'isolated-preview-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === '/api') {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                tag,
                method: req.method,
                credentials: Boolean(
                  req.headers.cookie ||
                  req.headers.authorization?.includes('management-dummy') ||
                  req.headers['cf-access-jwt-assertion'],
                ),
                applicationAuthorization: req.headers.authorization ?? null,
              }),
            );
          } else if (req.url === '/events') {
            res.setHeader('content-type', 'text/event-stream');
            res.write('data: fixture\n\n');
            const timer = setInterval(() => res.write('data: fixture\n\n'), 100);
            res.on('close', () => clearInterval(timer));
          } else next();
        });
        vite.httpServer!.on('upgrade', (req, socket, head) => {
          if (req.url === '/business-ws')
            business.handleUpgrade(req, socket, head, (ws) => business.emit('connection', ws, req));
        });
      },
    },
  ],
});
await server.listen();
process.send?.({ port: (server.httpServer!.address() as { port: number }).port, pid: process.pid });
process.on('message', async (message) => {
  if (message === 'disconnect-hmr') {
    for (const client of server.ws.clients) client.socket.terminate();
    process.send?.('hmr-disconnected');
  }
  if (message === 'close') {
    business.close();
    await server.close();
    process.exit(0);
  }
});

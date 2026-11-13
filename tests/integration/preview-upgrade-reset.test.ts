import { it, expect } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { guardPreviewUpgrades } from '../../src/server/preview/websockets.js';
import { captureLogger } from '../fixtures/logging.js';

it('contains a real peer reset while preview upgrade authorization is awaiting OS checks', async () => {
  const logger = captureLogger();
  const server = createServer();
  let accepted: Socket | undefined;
  guardPreviewUpgrades(server, logger.logger);
  const reset = new Promise<void>((resolve) => {
    server.on('upgrade', (_request, socket) => {
      accepted = socket as Socket;
      socket.once('close', () => resolve());
      socket.resume();
      client.resetAndDestroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = connect((server.address() as { port: number }).port, '127.0.0.1');
  try {
    await once(client, 'connect');
    client.write(
      'GET /preview/private-fixture/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    await reset;
    expect(
      logger.records.some((record) => record.event === 'gateway.upgrade_transport_failed'),
    ).toBe(true);
    expect(JSON.stringify(logger.records)).not.toContain('private-fixture');
  } finally {
    accepted?.destroy();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

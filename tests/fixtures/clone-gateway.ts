/** Isolated gateway process for restart tests; never uses the user's service or Codex. */
import { startGateway } from '../../src/server/main.js';
import { parseConfig } from '../../src/server/config.js';
import { DomainCodex } from '../integration/domain-helpers.js';
import { join } from 'node:path';
const root = process.argv[2]!;
const port = Number(process.argv[3]);
const config = parseConfig(
  { port, publicOrigin: [`http://127.0.0.1:${port}`], dataDir: join(root, 'data') },
  join(root, 'config.json'),
);
config.demo = true;
const runtime = await startGateway(config, { codex: new DomainCodex() });
process.send?.({ type: 'ready' });
process.on('message', async (message: string) => {
  if (message === 'readiness') process.send?.(runtime.service.prepareUpdate('update', false));
  if (message === 'close') {
    await runtime.close();
    process.exit(0);
  }
});
process.on('disconnect', async () => {
  await runtime.close();
  process.exit(0);
});

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitCloneFixture } from '../helpers/git-clone.js';
import type { ProjectClone } from '../../src/shared/types.js';

it('kills owned Git on abrupt gateway loss, recovers interruption on a real isolated restart and deduplicates POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'covro-clone-restart-'));
  const env = gitCloneFixture(root);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  let child: ChildProcess | undefined;
  const start = async () => {
    child = fork(resolve('tests/fixtures/clone-gateway.ts'), [root, String(port)], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Isolated gateway exited: ${code}`);
      }),
    ]);
  };
  try {
    await start();
    const input = {
      clientOperationId: randomUUID(),
      repository: 'https://example.test/slow.git',
      path: join(root, 'checkout'),
    };
    const started = await fetch(`${origin}/api/project-clones`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    expect(started.status).toBe(202);
    const id = ((await started.json()) as ProjectClone).id;
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number((await readFile(env.COVRO_TEST_GIT_PIDS, 'utf8')).trim());
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    child!.send('readiness');
    expect((await once(child!, 'message'))[0]).toEqual({
      ready: false,
      reason: '等待项目克隆完成或取消',
    });
    child!.kill('SIGKILL');
    await once(child!, 'exit');
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 6000 });
    // Production instance locking intentionally takes 10 seconds to reclaim an abrupt owner's lock.
    await pause(11_000);
    await start();
    const jobs = (await (await fetch(`${origin}/api/project-clones`)).json()) as {
      data: ProjectClone[];
    };
    expect(jobs.data).toHaveLength(1);
    expect(jobs.data[0]).toMatchObject({
      id,
      status: 'interrupted',
      progressStage: 'interrupted',
      errorCode: 'CLONE_INTERRUPTED',
    });
    const repeated = await fetch(`${origin}/api/project-clones`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    expect(await repeated.json()).toMatchObject({ id, status: 'interrupted' });
    expect((await readFile(env.COVRO_TEST_GIT_CALLS, 'utf8')).trim().split('\n')).toHaveLength(1);
    child!.send('readiness');
    expect((await once(child!, 'message'))[0]).toEqual({ ready: true });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.send('close');
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

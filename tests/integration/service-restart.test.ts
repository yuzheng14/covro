import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { expect, it } from 'vitest';
import { acquireLifecycle } from '../../src/cli/background.js';
import { paths } from '../../src/cli/paths.js';
import { acquireInstanceLock } from '../../src/server/instance-lock.js';

it.each(['failed preflight', 'successful handoff'])(
  'keeps independent instance and lifecycle leases during %s',
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'covro-restart-lock-'));
    const location = { ...paths(join(directory, 'config.json')), state: join(directory, 'state') };
    const releaseInstance = await acquireInstanceLock(location.state);
    const releaseLifecycle = await acquireLifecycle(location, false);
    const instanceHeld = () => lockfile.check(location.state);
    const lifecycleHeld = () =>
      lockfile.check(location.state, { lockfilePath: join(location.state, 'lifecycle.lock') });
    try {
      if (scenario === 'failed preflight') {
        await releaseLifecycle();
        expect(await lifecycleHeld()).toBe(false);
        expect(await instanceHeld()).toBe(true);
        await releaseInstance();
      } else {
        await releaseInstance();
        expect(await instanceHeld()).toBe(false);
        expect(await lifecycleHeld()).toBe(true);
        await releaseLifecycle();
      }
      expect(await instanceHeld()).toBe(false);
      expect(await lifecycleHeld()).toBe(false);
    } finally {
      await Promise.allSettled([releaseLifecycle(), releaseInstance()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

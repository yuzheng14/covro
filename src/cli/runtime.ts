import { join, resolve } from 'node:path';
import { packageRoot } from './paths.js';
import type { RuntimeIdentity } from '../shared/updates.js';

export const runningRuntime = (): RuntimeIdentity => ({
  node: process.execPath,
  nodeVersion: process.versions.node,
  root: resolve(packageRoot),
  entry: join(packageRoot, 'bin/covro.mjs'),
});

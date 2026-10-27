import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  resolveRuntimeTarget,
  assertRuntime,
  targetNpmEnvironment,
} from '../../src/updates/runtime.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await realpath(await mkdtemp('/tmp/c281-target-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const prefix = join(directory, 'global with space');
  const root = join(prefix, 'lib/node_modules/@covro/covro');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@covro/covro', version: '0.6.0' }),
  );
  await writeFile(join(root, 'bin/covro.mjs'), '');
  await symlink(join(root, 'bin/covro.mjs'), join(prefix, 'bin/covro'));
  const actualNode = await realpath(process.execPath);
  const actualNpm = await realpath(join(dirname(actualNode), 'npm'));
  const environment = async () => ({
    node: actualNode,
    nodeVersion: process.versions.node,
    path: `${dirname(actualNode)}:/usr/bin:/bin`,
    npmConfig: { prefix },
  });
  return { directory, root, prefix, actualNode, actualNpm, environment };
}

it('uses the selected Node npm CLI and fresh prefix rather than inherited npm configuration', async () => {
  const f = await fixture();
  vi.stubEnv('NPM_CONFIG_PREFIX', '/stale/old/node');
  const target = await resolveRuntimeTarget(f.environment);
  expect(target).toMatchObject({
    node: f.actualNode,
    npm: f.actualNpm,
    root: f.root,
    entry: join(f.root, 'bin/covro.mjs'),
    prefix: f.prefix,
  });
  expect(target.path.split(':')[0]).toBe(dirname(f.actualNode));
  expect(await readFile(join(f.root, 'package.json'), 'utf8')).toContain('0.6.0');
});

it('rejects a missing global installation and a CLI linked to another installation', async () => {
  const f = await fixture();
  await rm(join(f.prefix, 'bin/covro'));
  await symlink('/wrong/covro.mjs', join(f.prefix, 'bin/covro'));
  await expect(resolveRuntimeTarget(f.environment)).rejects.toThrow('npm install -g @covro/covro');
  await rm(f.root, { recursive: true });
  await expect(resolveRuntimeTarget(f.environment)).rejects.toThrow('当前服务保持运行');
});

it('rejects a changed Node version and refuses activation without exact actual process identity', async () => {
  const f = await fixture();
  await expect(
    resolveRuntimeTarget(async () => ({ ...(await f.environment()), nodeVersion: '23.0.0' })),
  ).rejects.toThrow('不受支持');
  const expected = {
    node: '/new/node',
    nodeVersion: '24.22.1',
    root: '/new/covro',
    entry: '/new/covro/bin/covro.mjs',
  };
  expect(() => assertRuntime(undefined, expected)).toThrow('拒绝激活');
  expect(() => assertRuntime({ ...expected, node: '/old/node' }, expected)).toThrow('拒绝激活');
  expect(() => assertRuntime(expected, expected)).not.toThrow();
});

it('drops old npm prefix configuration without persisting unrelated credentials', () => {
  vi.stubEnv('NPM_CONFIG_PREFIX', '/old');
  vi.stubEnv('npm_config_userconfig', '/old/.npmrc');
  const env = targetNpmEnvironment('/new/bin', { prefix: '/new' });
  expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
  expect(env.npm_config_userconfig).toBeUndefined();
  expect(env.npm_config_prefix).toBe('/new');
  expect(env.PATH).toBe('/new/bin');
});

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { packageInfo } from '../../src/cli/paths.js';
import type { RuntimeIdentity, UpdateRun, UpdateStatus } from '../../src/shared/updates.js';

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
beforeAll(async () => {
  await exec(process.execPath, ['--import', 'tsx', 'scripts/build-server.ts']);
}, 30_000);

async function fixture(
  codex?: {
    explicit?: boolean;
    mismatch?: boolean;
    automatic?: boolean;
    ui?: boolean;
    keepCovroVersion?: boolean;
  },
  web = false,
) {
  // Short private Unix socket paths; HOME, Codex data and all npm prefixes are disposable.
  const directory = await realpath(await mkdtemp('/tmp/c281-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const shellHome = join(directory, 'shell');
  await mkdir(shellHome);
  const home = join(directory, 'home');
  const roots: string[] = [];
  const nodes: string[] = [];
  for (const [index, binary] of [
    process.execPath,
    process.env.COVRO_TEST_NODE_B ?? process.execPath,
  ].entries()) {
    const prefix = join(directory, String(index));
    const root = join(prefix, 'lib/node_modules/@covro/covro');
    const node = join(prefix, 'bin/node');
    await mkdir(dirname(node), { recursive: true });
    await mkdir(root, { recursive: true });
    await cp(await realpath(binary), node);
    await symlink(
      await realpath(join(dirname(await realpath(binary)), 'npm')),
      join(prefix, 'bin/npm'),
    );
    await cp('bin', join(root, 'bin'), { recursive: true });
    await cp('dist', join(root, 'dist'), {
      recursive: true,
      filter: (path) => (web || !/^dist\/web(?:\/|$)/.test(path)) && !path.endsWith('.map'),
    });
    if (codex?.ui) {
      await cp('dist/web', join(root, 'dist/web'), { recursive: true });
      // Each disposable package serves the frontend version matching its package metadata.
      for (const file of await readdir(join(root, 'dist/web/assets'))) {
        if (!file.endsWith('.js')) continue;
        const path = join(root, 'dist/web/assets', file);
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replaceAll(
            packageInfo.version,
            index === 0 ? '0.8.1-dev.5' : '0.8.1-dev.6',
          ),
        );
      }
    }
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify(
        codex
          ? {
              ...packageInfo,
              version: codex.keepCovroVersion
                ? packageInfo.version
                : index === 0
                  ? '0.8.1-dev.5'
                  : '0.8.1-dev.6',
              covroCommit: String(index === 0 ? 5 : 6).repeat(40),
              covroCodex: {
                recommended: index === 0 ? '0.166.0' : '0.167.0',
                verified: [index === 0 ? '0.166.0' : '0.167.0'],
                unsupported: [],
              },
            }
          : packageInfo,
      ),
    );
    if (codex) {
      await writeFile(
        join(prefix, 'bin/codex-version.json'),
        JSON.stringify({
          reported: index === 0 ? '0.166.0' : '0.167.0',
          actual: codex.mismatch && index === 1 ? '0.168.0' : index === 0 ? '0.166.0' : '0.167.0',
        }),
      );
      await writeFile(
        join(prefix, 'bin/codex'),
        `#!/usr/bin/env node\nimport {readFileSync} from 'node:fs';\nimport {spawn} from 'node:child_process';\nconst version=JSON.parse(readFileSync(new URL('./codex-version.json',import.meta.url)));\nif(process.argv.includes('--version')) console.log('codex-cli '+version.reported);\nelse { const child=spawn(process.execPath,['--import','tsx',${JSON.stringify(resolve('tests/fixtures/app-server.ts'))},...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,COVRO_FIXTURE_CODEX_VERSION:version.actual}}); for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1)); }\n`,
      );
      await chmod(join(prefix, 'bin/codex'), 0o755);
    }
    await symlink(join(root, 'bin/covro.mjs'), join(prefix, 'bin/covro'));
    roots.push(root);
    nodes.push(node);
  }
  const targetPrefix = join(directory, '1');
  const startup = `export PATH='${targetPrefix}/bin:/usr/bin:/bin'\nexport npm_config_prefix='${targetPrefix}'\n`;
  for (const name of ['.zshrc', '.bash_profile', '.bashrc', '.profile'])
    await writeFile(join(shellHome, name), startup);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => probe.close(() => done()));
  const config = join(directory, 'config.json');
  const configText = JSON.stringify({
    port: address.port,
    publicOrigin: [`http://127.0.0.1:${address.port}`],
    dataDir: './data',
    codex: {
      binary: codex
        ? codex.explicit
          ? join(directory, '0/bin/codex')
          : 'codex'
        : resolve('tests/fixtures/codex.mjs'),
    },
  });
  await writeFile(config, configText);
  const releaseMetadata = join(directory, 'release.json');
  await writeFile(releaseMetadata, await readFile(join(roots[codex ? 1 : 0]!, 'package.json')));
  const env = {
    ...process.env,
    HOME: shellHome,
    ZDOTDIR: shellHome,
    COVRO_HOME: home,
    CODEX_HOME: join(directory, 'codex'),
    PATH: `${dirname(nodes[0]!)}:${process.env.PATH}`,
    npm_config_prefix: join(directory, '0'),
    NODE_OPTIONS: `--import=${resolve('tests/fixtures/runtime-preload.mjs')}`,
    COVRO_TEST_RELEASE_METADATA: releaseMetadata,
  };
  // Never inherit real service-manager ownership into an isolated instance.
  for (const key of ['INVOCATION_ID', 'PM2_HOME', 'SUPERVISOR_ENABLED'])
    delete (env as NodeJS.ProcessEnv)[key];
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(nodes[0]!, [join(roots[0]!, 'bin/covro.mjs'), ...args, '--config', config], {
          env,
          timeout: 30_000,
        })
      ).stdout,
    ) as UpdateStatus & {
      pid: number;
      runtime: RuntimeIdentity;
      codexReady: boolean;
      codexVersion: string | null;
    };
  cleanups.push(async () => {
    await exec(nodes[0]!, [join(roots[0]!, 'bin/covro.mjs'), 'stop', '--config', config], { env });
  });
  if (codex?.automatic) {
    const updateKey = createHash('sha256')
      .update(roots[0]! + '/')
      .digest('hex')
      .slice(0, 16);
    await mkdir(join(home, 'updates', updateKey), { recursive: true });
    await writeFile(
      join(home, 'updates', updateKey, 'settings.json'),
      JSON.stringify({ channel: 'dev', automatic: true }),
    );
  }
  await cli('start');
  await expect.poll(async () => (await cli('status')).codexReady, { timeout: 30_000 }).toBe(true);
  const db = new Database(join(directory, 'data/app.sqlite'));
  db.prepare('INSERT INTO preferences VALUES (?, ?)').run('runtime-test', '"preserved"');
  db.close();
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: object) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  return {
    cli,
    directory,
    roots,
    nodes,
    config,
    configText,
    home,
    releaseMetadata,
    env,
    origin,
    post,
  };
}

it('automatically activates the verified restart combination while the running Codex is still 0.166.0', async () => {
  const f = await fixture({ automatic: true });
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('succeeded');
  const result = await f.cli('update', 'status');
  expect(result.run).toMatchObject({
    from: '0.8.1-dev.5',
    target: '0.8.1-dev.6',
    codex: { version: '0.167.0', confirmedUnverified: false },
  });
  expect(await f.cli('status')).toMatchObject({
    version: '0.8.1-dev.6',
    codexVersion: '0.167.0',
    codexReady: true,
  });
}, 60_000);

it.each(['upgrade', 'downgrade', 'remove', 'path', 'config'] as const)(
  'refuses %s during a real approval wait without stopping the original daemon',
  async (change) => {
    const f = await fixture({});
    const post = async (path: string, body: object) => {
      const response = await fetch(f.origin + path, {
        method: 'POST',
        headers: { origin: f.origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const project = (await post('/api/projects', {
      path: f.directory,
      name: 'Isolated approval',
    })) as { id: string };
    const thread = (await post(`/api/projects/${project.id}/threads`, {
      clientOperationId: randomUUID(),
    })) as { result: { threadId: string } };
    await post(`/api/threads/${thread.result.threadId}/turns`, {
      clientOperationId: randomUUID(),
      text: '[approval]',
    });
    const before = await f.cli('status');
    await f.cli('update');
    await expect
      .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
      .toBe('waiting');
    const versionFile = join(f.directory, '1/bin/codex-version.json');
    if (change === 'upgrade' || change === 'downgrade')
      await writeFile(
        versionFile,
        JSON.stringify({
          reported: change === 'upgrade' ? '0.168.0' : '0.166.0',
          actual: '0.167.0',
        }),
      );
    if (change === 'remove') await rm(join(f.directory, '1/bin/codex'));
    if (change === 'path') {
      const other = join(f.directory, 'other');
      await mkdir(other);
      await cp(join(f.directory, '1/bin/codex'), join(other, 'codex'));
      await cp(versionFile, join(other, 'codex-version.json'));
      await rm(join(f.directory, '1/bin/codex'));
      await symlink(join(other, 'codex'), join(f.directory, '1/bin/codex'));
    }
    if (change === 'config')
      await writeFile(
        f.config,
        JSON.stringify({
          ...JSON.parse(f.configText),
          codex: { binary: join(f.directory, '0/bin/codex') },
        }),
      );
    await expect
      .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
      .toBe('failed');
    expect(await f.cli('status')).toMatchObject({
      pid: before.pid,
      version: '0.8.1-dev.5',
      codexVersion: '0.166.0',
      maintenance: false,
    });
    expect((await f.cli('update', 'status')).run?.committed).not.toBe(true);
  },
  60_000,
);

it('upgrades the reported 0.8.1-dev.5 / Codex 0.166.0 example to dev.6 / 0.167.0 without stopping early', async () => {
  const screenshots = process.env.COVRO_SCREENSHOTS;
  const f = await fixture({ ui: Boolean(screenshots) });
  const before = await f.cli('status');
  const checked = await f.cli('update', 'status');
  expect(checked).toMatchObject({
    version: '0.8.1-dev.5',
    codex: { version: '0.166.0', status: 'verified' },
    available: { version: '0.8.1-dev.6', codex: { version: '0.167.0', status: 'verified' } },
  });
  expect((await f.cli('status')).pid).toBe(before.pid);
  const browser = screenshots
    ? await (await import('@playwright/test')).chromium.launch()
    : undefined;
  if (browser) cleanups.push(() => browser.close());
  const page = await browser?.newPage({ viewport: { width: 1440, height: 1400 }, locale: 'zh-CN' });
  if (page && screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.goto(f.origin);
    await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page
      .getByRole('region', { name: '目标版本兼容性', exact: true })
      .getByText('0.167.0', { exact: true })
      .waitFor();
    await expect
      .poll(() => page.getByRole('button', { name: '升级并重启', exact: true }).isEnabled())
      .toBe(true);
    await page
      .getByRole('region', { name: '目标版本兼容性', exact: true })
      .locator('summary')
      .click();
    await page.screenshot({ path: join(screenshots, '335-isolated-before.png'), fullPage: true });
    await page.getByRole('button', { name: '升级并重启', exact: true }).click();
  } else await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('succeeded');
  expect(await f.cli('status')).toMatchObject({
    version: '0.8.1-dev.6',
    codexVersion: '0.167.0',
    codexReady: true,
  });
  expect((await f.cli('update', 'status')).codex.version).toBe('0.167.0');
  if (page && screenshots) {
    await page.goto(f.origin);
    await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    await page
      .getByRole('region', { name: '正在运行的 Codex', exact: true })
      .getByText('0.167.0', { exact: true })
      .waitFor();
    await page.screenshot({ path: join(screenshots, '335-isolated-after.png'), fullPage: true });
  }
}, 60_000);

it('keeps an explicit old Codex path unverified even with a verified version elsewhere in the target PATH', async () => {
  const f = await fixture({ explicit: true });
  const before = await f.cli('status');
  const checked = await f.cli('update', 'status');
  expect(checked.available?.codex).toMatchObject({ version: '0.166.0', status: 'unverified' });
  await expect(f.cli('update')).rejects.toThrow('尚未验证');
  expect((await f.cli('status')).pid).toBe(before.pid);
  expect((await f.cli('update', 'status')).run).toBeUndefined();
}, 60_000);

it('uses the selected preinstalled Covro parser and blocks a staged parser that changes the Codex source before stopping', async () => {
  const f = await fixture({});
  const configModule = join(f.roots[1]!, 'dist/server/config.js');
  const source = await readFile(configModule, 'utf8');
  const marker = 'const config = parseFileConfig(value);';
  expect(source).toContain(marker);
  await writeFile(
    configModule,
    source.replace(
      marker,
      `${marker}\nconfig.codex.binary = ${JSON.stringify(join(f.directory, '0/bin/codex'))};`,
    ),
  );
  // The preinstalled candidate already has its own configuration interpretation.
  expect((await f.cli('update', 'status')).available?.codex).toMatchObject({
    version: '0.166.0',
    status: 'unverified',
  });
  const prefix = join(f.directory, '1');
  const npm = join(prefix, 'npm/bin/npm-cli.js');
  await mkdir(dirname(npm), { recursive: true });
  await cp('tests/fixtures/runtime-npm.mjs', npm);
  await chmod(npm, 0o755);
  await writeFile(join(prefix, 'npm/package.json'), JSON.stringify({ name: 'npm' }));
  await rm(join(prefix, 'bin/npm'));
  await symlink(npm, join(prefix, 'bin/npm'));
  // A remote higher release is checked before its code is available locally.
  await writeFile(f.releaseMetadata, JSON.stringify({ ...packageInfo, version: '99.0.0' }));
  expect((await f.cli('update', 'status')).available?.codex).toMatchObject({
    version: '0.167.0',
    status: 'verified',
  });
  const before = await f.cli('status');
  await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('failed');
  expect(await readFile(f.releaseMetadata + '.npm.json', 'utf8')).toContain('@covro/covro@99.0.0');
  expect(await f.cli('status')).toMatchObject({
    pid: before.pid,
    version: '0.8.1-dev.5',
    codexVersion: '0.166.0',
    maintenance: false,
  });
}, 60_000);

it('rolls back when the restarted app-server reports a different version from its CLI probe', async () => {
  const f = await fixture({ mismatch: true });
  await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 90_000 })
    .toBe('rolledBack');
  expect(await f.cli('status')).toMatchObject({
    version: '0.8.1-dev.5',
    codexVersion: '0.166.0',
    codexReady: true,
  });
  const db = new Database(join(f.directory, 'data/app.sqlite'));
  expect(db.prepare('SELECT value FROM preferences WHERE key=?').get('runtime-test')).toEqual({
    value: '"preserved"',
  });
  db.close();
}, 120_000);

it('migrates an equal Covro version to the default Node and keeps it on a later old-CLI start', async () => {
  const f = await fixture();
  const before = await f.cli('status');
  expect(before.runtime.node).toBe(f.nodes[0]);
  const checked = await f.cli('update', 'status');
  expect(checked.runtime).toMatchObject({
    migration: true,
    target: { node: f.nodes[1], root: f.roots[1] },
  });
  expect(checked.available?.version).toBe(packageInfo.version);
  await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('succeeded');
  const after = await f.cli('status');
  expect(after.runtime.node).toBe(f.nodes[1]);
  expect(after.runtime.root).toBe(f.roots[1]);
  expect(after.pid).not.toBe(before.pid);
  const update = await f.cli('update', 'status');
  expect(update.run?.runtime?.actual?.node).toBe(f.nodes[1]);
  expect(update.run?.committed).toBe(true);
  expect(await readFile(f.config, 'utf8')).toBe(f.configText);
  const db = new Database(join(f.directory, 'data/app.sqlite'));
  expect(db.prepare('SELECT value FROM preferences WHERE key=?').get('runtime-test')).toEqual({
    value: '"preserved"',
  });
  db.close();
  await exec(f.nodes[0]!, [join(f.roots[0]!, 'bin/covro.mjs'), 'stop', '--config', f.config], {
    env: { ...process.env, COVRO_HOME: f.home },
  });
  await f.cli('start');
  expect((await f.cli('status')).runtime.node).toBe(f.nodes[1]);
  expect((await f.cli('status')).runtime.root).toBe(f.roots[1]);
}, 60_000);

it('stages a newer release with the target Node/npm and activates its global installation', async () => {
  const f = await fixture();
  const prefix = join(f.directory, '1');
  const npm = join(prefix, 'npm/bin/npm-cli.js');
  await mkdir(dirname(npm), { recursive: true });
  await cp('tests/fixtures/runtime-npm.mjs', npm);
  await chmod(npm, 0o755);
  await writeFile(join(prefix, 'npm/package.json'), JSON.stringify({ name: 'npm' }));
  await rm(join(prefix, 'bin/npm'));
  await symlink(npm, join(prefix, 'bin/npm'));
  // A greater major makes the fixture independent of this repository's release version.
  const targetVersion = `${Number(packageInfo.version.split('.')[0]) + 1}.0.0`;
  await writeFile(f.releaseMetadata, JSON.stringify({ ...packageInfo, version: targetVersion }));
  await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('succeeded');
  const actual = await f.cli('status');
  expect(actual.version).toBe(targetVersion);
  expect(actual.runtime.node).toBe(f.nodes[1]);
  expect(actual.runtime.root).toBe(f.roots[1]);
  const installedBy = JSON.parse(await readFile(f.releaseMetadata + '.npm.json', 'utf8')) as {
    node: string;
    args: string[];
  };
  expect(installedBy.node).toBe(f.nodes[1]);
  expect(installedBy.args).toContain('@covro/covro@' + targetVersion);
  expect(installedBy.args).toContain('--prefix');
  expect((await f.cli('update', 'status')).run?.runtime?.target.npm).toBe(npm);
  expect(JSON.parse(await readFile(join(f.roots[0]!, 'package.json'), 'utf8')).version).toBe(
    packageInfo.version,
  );
}, 60_000);

it('leaves the old process running when the target global CLI is missing', async () => {
  const f = await fixture();
  const before = await f.cli('status');
  await rm(join(f.directory, '1/bin/covro'));
  const checked = await f.cli('update', 'status');
  expect(checked.runtime?.error).toContain('npm install -g @covro/covro');
  await expect(f.cli('update')).rejects.toThrow('当前服务保持运行');
  expect((await f.cli('status')).pid).toBe(before.pid);
  expect((await f.cli('status')).runtime.node).toBe(f.nodes[0]);
}, 60_000);

it('restores the original runtime and data when an equal-version target fails startup', async () => {
  const f = await fixture();
  await writeFile(
    join(f.roots[1]!, 'bin/covro.mjs'),
    `if (process.argv[2] === 'run') throw new Error('isolated startup failure');\n` +
      (await readFile(join(f.roots[1]!, 'bin/covro.mjs'), 'utf8').then((s) =>
        s.replace(/^#!.*\n/, ''),
      )),
  );
  await f.cli('update');
  await expect
    .poll(async () => (await f.cli('update', 'status')).run?.phase, { timeout: 30_000 })
    .toBe('rolledBack');
  await expect
    .poll(async () => (await f.cli('status')).runtime.node, { timeout: 30_000 })
    .toBe(f.nodes[0]);
  expect(await readFile(f.config, 'utf8')).toBe(f.configText);
  const db = new Database(join(f.directory, 'data/app.sqlite'));
  expect(db.prepare('SELECT value FROM preferences WHERE key=?').get('runtime-test')).toEqual({
    value: '"preserved"',
  });
  db.close();
}, 60_000);

it.each(['success', 'rollback'] as const)(
  'refreshes one idle automatic plan and pins its real %s transaction',
  async (mode) => {
    const f = await fixture({ keepCovroVersion: true }, Boolean(process.env.COVRO_SCREENSHOTS));
    const prefix = join(f.directory, '1');
    const npm = join(prefix, 'npm/bin/npm-cli.js');
    await mkdir(dirname(npm), { recursive: true });
    await cp('tests/fixtures/runtime-npm.mjs', npm);
    await chmod(npm, 0o755);
    await writeFile(join(prefix, 'npm/package.json'), JSON.stringify({ name: 'npm' }));
    await rm(join(prefix, 'bin/npm'));
    await symlink(npm, join(prefix, 'bin/npm'));
    if (process.env.COVRO_SCREENSHOTS) {
      // Fixture packages change version without rebuilding Vite. Keep the candidate UI identity
      // aligned as a real release would, so its normal upgrade reload settles after activation.
      const assets = join(f.roots[1]!, 'dist/web/assets');
      for (const file of await readdir(assets)) {
        if (!file.startsWith('index-') || !file.endsWith('.js')) continue;
        const path = join(assets, file);
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replaceAll(packageInfo.version, '99.0.0-dev.5'),
        );
      }
    }
    if (mode === 'rollback') {
      const entry = join(f.roots[1]!, 'bin/covro.mjs');
      await writeFile(
        entry,
        `if (process.argv[2] === 'run') throw new Error('isolated automatic failure');\n` +
          (await readFile(entry, 'utf8')).replace(/^#!.*\n/, ''),
      );
    }
    const project = (await f.post('/api/projects', {
      path: f.directory,
      name: 'Idle update verification',
    })) as { id: string };
    const held = (await f.post(`/api/projects/${project.id}/shell`, {
      clientOperationId: randomUUID(),
      command: 'sleep 120',
    })) as { result: { shellCommand: { id: string } } };
    const updateDir = join(
      f.home,
      'updates',
      createHash('sha256')
        .update(f.roots[0]! + '/')
        .digest('hex')
        .slice(0, 16),
    );
    const writeRelease = (n: number) =>
      writeFile(
        f.releaseMetadata,
        JSON.stringify({
          ...packageInfo,
          version: `99.0.0-dev.${n}`,
          covroCommit: String(n).repeat(40),
        }),
      );
    await f.cli('update', 'status');
    await writeRelease(3);
    await f.post('/api/updates/settings', { channel: 'dev', automatic: true });
    const checked = (await f.post('/api/updates/check', { channel: 'dev' })) as UpdateStatus;
    const source = await f.cli('status');
    const run: UpdateRun = {
      id: randomUUID(),
      from: packageInfo.version,
      target: checked.available!.version,
      channel: 'dev',
      sourceChannel: checked.available!.channel,
      commit: checked.available!.commit,
      automatic: {
        revision: JSON.parse(await readFile(join(updateDir, 'settings-revision.json'), 'utf8')),
      },
      candidate: checked.available,
      runtime: { from: source.runtime, target: checked.runtime!.target! },
      phase: 'waiting',
      message: 'Waiting for shell task',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeFile(
      join(updateDir, 'context.json'),
      JSON.stringify({
        location: (await import('../../src/cli/paths.js')).paths(f.config),
        root: f.roots[0] + '/',
        directory: updateDir,
        dataDir: join(f.directory, 'data'),
        source: { node: f.nodes[0], entry: join(f.roots[0]!, 'bin/covro.mjs'), path: f.env.PATH },
        target: checked.runtime!.target,
      }),
    );
    // paths() is evaluated in the test process; explicitly use the isolated home/socket.
    const context = JSON.parse(await readFile(join(updateDir, 'context.json'), 'utf8'));
    const location = context.location;
    const isolatedState = join(f.home, 'instances', location.key);
    Object.assign(location, {
      home: f.home,
      state: isolatedState,
      socket: join(f.home, `c-${location.key}.sock`),
      logs: join(isolatedState, 'logs'),
      log: join(isolatedState, 'covro.log'),
    });
    await writeFile(join(updateDir, 'context.json'), JSON.stringify(context));
    await writeFile(join(updateDir, 'run.json'), JSON.stringify(run));
    await writeFile(join(isolatedState, 'updates.json'), JSON.stringify({ directory: updateDir }));
    const child = spawn(f.nodes[0]!, [resolve('dist/update-worker.cjs'), updateDir], {
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
      process.stderr.write(chunk);
    });
    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    });
    const status = async () =>
      JSON.parse(await readFile(join(updateDir, 'run.json'), 'utf8')) as UpdateRun;
    const browser = process.env.COVRO_SCREENSHOTS ? await chromium.launch() : undefined;
    if (browser) cleanups.push(() => browser.close());
    const page = await browser?.newPage({
      viewport: { width: 1440, height: 1200 },
      locale: 'zh-CN',
    });
    if (page) {
      await page.goto(f.origin);
      await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    }
    const capture = async (state: string) => {
      if (!page || !process.env.COVRO_SCREENSHOTS) return;
      const progress = page.locator('.update-progress');
      await progress.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(process.env.COVRO_SCREENSHOTS, `325-isolated-${mode}-${state}.png`),
        fullPage: true,
      });
    };

    for (const n of [4, 5]) {
      await writeRelease(n);
      await f.post('/api/updates/check', { channel: 'dev' });
      await expect
        .poll(
          async () => {
            const r = await status();
            if (r.phase === 'failed') throw new Error(JSON.stringify(r) + errors);
            return r.target;
          },
          { timeout: 15_000 },
        )
        .toBe(`99.0.0-dev.${n}`);
      expect((await status()).id).toBe(run.id);
      expect((await status()).codex?.target?.identity.version).toBe('0.167.0');
      expect((await f.cli('status')).codexVersion).toBe('0.166.0');
      if (page) {
        await page
          .locator('.update-progress')
          .filter({ hasText: `99.0.0-dev.${n}` })
          .waitFor();
        await capture(`refreshed-${n}`);
      }
      expect((await f.cli('status')).pid).toBe(source.pid);
      expect(
        await readFile(f.releaseMetadata + '.npm.json', 'utf8').catch(() => undefined),
      ).toBeUndefined();
    }
    // The npm fixture moves the channel again while installing. This cannot change the frozen target.
    const afterInstall = join(f.directory, 'after-install.json');
    await writeFile(
      afterInstall,
      JSON.stringify({ ...packageInfo, version: '99.0.0-dev.6', covroCommit: '6'.repeat(40) }),
    );
    await writeFile(f.releaseMetadata + '.after-install', await readFile(afterInstall));
    await f.post(`/api/shell/${held.result.shellCommand.id}/interrupt`, {
      clientOperationId: randomUUID(),
    });
    await expect
      .poll(async () => (await status()).phase, { timeout: 60_000 })
      .toBe(mode === 'success' ? 'succeeded' : 'rolledBack');
    // rolledBack is recorded before the old daemon finishes starting; wait for verified recovery.
    await expect.poll(() => child.exitCode, { timeout: 60_000 }).toBe(0);
    if (page) {
      await page.goto(f.origin);
      await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
      await page
        .locator(
          `.update-progress[data-phase="${mode === 'success' ? 'succeeded' : 'rolledBack'}"]`,
        )
        .waitFor({ timeout: 15_000 });
      await capture('final');
    }
    const final = await status();
    expect(final).toMatchObject({
      id: run.id,
      target: '99.0.0-dev.5',
      commit: '5'.repeat(40),
      transactionStartedAt: expect.any(Number),
      codex: { version: '0.167.0', target: { identity: { version: '0.167.0' } } },
    });
    expect((await f.cli('status')).codexVersion).toBe(mode === 'success' ? '0.167.0' : '0.166.0');
    const installedBy = JSON.parse(await readFile(f.releaseMetadata + '.npm.json', 'utf8')) as {
      args: string[];
    };
    expect(installedBy.args.at(-1)).toBe('@covro/covro@99.0.0-dev.5');
    expect(
      (await readFile(f.releaseMetadata + '.installs', 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
    expect((await f.cli('status')).version).toBe(
      mode === 'success' ? '99.0.0-dev.5' : packageInfo.version,
    );
    const db = new Database(join(f.directory, 'data/app.sqlite'));
    expect(db.prepare('SELECT value FROM preferences WHERE key=?').get('runtime-test')).toEqual({
      value: '"preserved"',
    });
    db.close();
  },
  90_000,
);

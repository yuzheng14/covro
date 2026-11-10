import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '../../src/cli/paths.js';
import { assertCodexTarget, probeRestartCodex } from '../../src/updates/codex-target.js';
import { saveJson } from '../../src/updates/files.js';
import { codexServerVersion } from '../../src/codex/identity.js';

const directories: string[] = [];
beforeEach(() => {
  // GitHub's Linux runner may itself be a systemd service. This fixture owns no service.
  for (const key of ['INVOCATION_ID', 'PM2_HOME', 'SUPERVISOR_ENABLED']) vi.stubEnv(key, undefined);
});
it('reads the server build version rather than client metadata, including custom originator names', () => {
  expect(
    codexServerVersion('codex_web_ui/0.167.0 (Darwin 26; arm64) Terminal (codex_web_ui; 0.1.0)'),
  ).toBe('0.167.0');
  expect(
    codexServerVersion('custom/name with spaces/0.167.0 (Linux 6; x64)', 'custom/name with spaces'),
  ).toBe('0.167.0');
  expect(codexServerVersion('unknown-agent/0.167.0')).toBeNull();
  expect(codexServerVersion('codex/00.167.0')).toBeNull();
});
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/build-server.ts']);
}, 30_000);
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp('/tmp/c335-probe-');
  directories.push(directory);
  const location = {
    ...paths(join(directory, 'config.json')),
    home: directory,
    state: join(directory, 'state'),
  };
  const binary = async (name: string, version: string) => {
    const bin = join(directory, name);
    await mkdir(bin);
    await symlink(process.execPath, join(bin, 'node'));
    await writeFile(
      join(bin, 'codex'),
      `#!/usr/bin/env node\nconsole.log('codex-cli '+(await import('node:fs')).readFileSync(new URL('./version',import.meta.url),'utf8'));\n`,
    );
    await chmod(join(bin, 'codex'), 0o700);
    await writeFile(join(bin, 'version'), version);
    return bin;
  };
  const old = await binary('old', '0.166.0');
  const targetBin = await binary('new', '0.167.0');
  await symlink(resolve('dist'), join(directory, 'dist'));
  await saveJson(location.config, {
    codex: { binary: 'codex', home: join(directory, 'codex-home') },
  });
  const target = {
    node: process.execPath,
    entry: join(directory, 'bin/covro.mjs'),
    path: `${targetBin}:${old}:/usr/bin:/bin`,
  };
  return {
    directory,
    location,
    old,
    targetBin,
    target,
    probe: () => probeRestartCodex(location, directory, target),
  };
}
it('resolves only the target PATH with its Node, configuration and Codex home', async () => {
  const f = await fixture();
  const found = await f.probe();
  expect(found.identity).toMatchObject({
    version: '0.167.0',
    resolved: join(f.targetBin, 'codex'),
    node: process.execPath,
  });
  await saveJson(f.location.config, { codex: { binary: join(f.old, 'codex') } });
  expect((await f.probe()).identity).toMatchObject({
    version: '0.166.0',
    resolved: join(f.old, 'codex'),
  });
});
it.each(['upgrade', 'downgrade', 'remove', 'path', 'config', 'file', 'launch'] as const)(
  'rejects %s changes after a successful target observation',
  async (change) => {
    const f = await fixture();
    const before = await f.probe();
    if (change === 'upgrade' || change === 'downgrade')
      await writeFile(join(f.targetBin, 'version'), change === 'upgrade' ? '0.168.0' : '0.166.0');
    if (change === 'remove') await rm(join(f.targetBin, 'codex'));
    if (change === 'path') f.target.path = `${f.old}:/usr/bin:/bin`;
    if (change === 'config')
      await saveJson(f.location.config, {
        codex: { binary: 'codex', home: join(f.directory, 'other-home') },
      });
    if (change === 'file')
      await writeFile(
        join(f.targetBin, 'codex'),
        (await readFile(join(f.targetBin, 'codex'), 'utf8')) + '// replacement\n',
      );
    if (change === 'launch')
      await saveJson(join(f.location.state, 'runtime.json'), {
        node: process.execPath,
        entry: f.target.entry,
        path: '/different',
      });
    await expect(f.probe().then((actual) => assertCodexTarget(actual, before))).rejects.toThrow(
      '变化',
    );
  },
);
it('blocks a missing or malformed explicit CLI instead of selecting another installed version', async () => {
  const f = await fixture();
  for (const binary of [join(f.directory, 'missing'), process.execPath]) {
    await saveJson(f.location.config, { codex: { binary } });
    await expect(f.probe()).rejects.toThrow('探测');
  }
});

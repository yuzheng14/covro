import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/install-e2e-deps.sh', import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function setup() {
  // Spaces also exercise quoting of local package paths passed to apt.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'e2e deps-')));
  fixtures.push(cwd);
  const bin = join(cwd, 'bin');
  const cache = join(cwd, '.local/e2e-deps/apt');
  const log = join(cwd, 'commands');
  const config = join(cwd, 'apt-config');
  mkdirSync(bin);
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(bin, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'printf "sudo" >> "$COMMAND_LOG"',
      'printf "\\t%s" "$@" >> "$COMMAND_LOG"',
      'printf "\\n" >> "$COMMAND_LOG"',
      // Never run elevated commands or change the host system in these tests.
      'if [[ "$1" == install ]]; then cp "$4" "$APT_CONFIG_CAPTURE"; fi',
      'if [[ "$1" == apt-get ]]; then exit "${APT_STUB_EXIT:-0}"; fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'printf "pnpm" >> "$COMMAND_LOG"',
      'printf "\\t%s" "$@" >> "$COMMAND_LOG"',
      'printf "\\n" >> "$COMMAND_LOG"',
      'exit "${PLAYWRIGHT_STUB_EXIT:-0}"',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    cache,
    config,
    commands: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    run: (mode: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync('bash', [script, mode], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ImageVersion: '20261026.1',
          E2E_CACHE_HIT: 'true',
          COMMAND_LOG: log,
          APT_CONFIG_CAPTURE: config,
          ...env,
        },
      }),
  };
}

const fullInstall = 'pnpm\texec\tplaywright\tinstall\t--with-deps\t--only-shell\tchromium';
const browserInstall = 'pnpm\texec\tplaywright\tinstall\t--only-shell\tchromium';

describe('CI E2E dependency installation', () => {
  it('retains downloaded packages and marks a completed preparation for the runner image', () => {
    const fixture = setup();
    expect(fixture.run('prepare').status).toBe(0);
    expect(readFileSync(fixture.config, 'utf8')).toContain(
      `Dir::Cache::archives "${fixture.cache}";`,
    );
    expect(readFileSync(fixture.config, 'utf8')).toContain('APT::Keep-Downloaded-Packages "true";');
    expect(readFileSync(join(fixture.cache, 'runner-image'), 'utf8')).toBe('20261026.1\n');
    expect(existsSync(join(fixture.cache, 'apt.conf'))).toBe(false);
    expect(fixture.commands()).toContain(fullInstall);
    expect(fixture.commands().at(-1)).toBe('sudo\trm\t-f\t/etc/apt/apt.conf.d/99covro-e2e-cache');
  });

  it('cleans up after a failed preparation without marking an incomplete cache ready', () => {
    const fixture = setup();
    expect(fixture.run('prepare', { PLAYWRIGHT_STUB_EXIT: '9' }).status).toBe(9);
    expect(existsSync(join(fixture.cache, 'runner-image'))).toBe(false);
    expect(existsSync(join(fixture.cache, 'apt.conf'))).toBe(false);
    expect(fixture.commands().at(-1)).toBe('sudo\trm\t-f\t/etc/apt/apt.conf.d/99covro-e2e-cache');
  });

  it('installs cached packages offline and skips the system dependency downloader', () => {
    const fixture = setup();
    writeFileSync(join(fixture.cache, 'runner-image'), '20261026.1\n');
    const deb = join(fixture.cache, 'fonts_1_amd64.deb');
    writeFileSync(deb, 'fixture');
    expect(fixture.run('install').status).toBe(0);
    expect(fixture.commands()).toEqual([
      `sudo\tapt-get\tinstall\t-y\t--no-install-recommends\t--no-download\t${deb}`,
      browserInstall,
    ]);
  });

  it.each([undefined, '20261019.1'])(
    'uses the source for missing or mismatched caches: %s',
    (image) => {
      const fixture = setup();
      if (image) writeFileSync(join(fixture.cache, 'runner-image'), image);
      expect(fixture.run('install').status).toBe(0);
      expect(fixture.commands()).toEqual([fullInstall]);
    },
  );

  it('falls back to the regular installer when cached packages cannot satisfy dependencies', () => {
    const fixture = setup();
    writeFileSync(join(fixture.cache, 'runner-image'), '20261026.1\n');
    writeFileSync(join(fixture.cache, 'fonts_1_amd64.deb'), 'fixture');
    expect(fixture.run('install', { APT_STUB_EXIT: '100' }).status).toBe(0);
    expect(fixture.commands()).toHaveLength(2);
    expect(fixture.commands()[0]).toContain('--no-download');
    expect(fixture.commands()[1]).toBe(fullInstall);
  });

  it('does not use files left behind by a failed cache restore', () => {
    const fixture = setup();
    writeFileSync(join(fixture.cache, 'runner-image'), '20261026.1\n');
    writeFileSync(join(fixture.cache, 'fonts_1_amd64.deb'), 'fixture');
    expect(fixture.run('install', { E2E_CACHE_HIT: 'false' }).status).toBe(0);
    expect(fixture.commands()).toEqual([fullInstall]);
  });

  it('handles an image that already provides all system packages', () => {
    const fixture = setup();
    writeFileSync(join(fixture.cache, 'runner-image'), '20261026.1\n');
    expect(fixture.run('install').status).toBe(0);
    expect(fixture.commands()).toEqual([browserInstall]);
  });
});

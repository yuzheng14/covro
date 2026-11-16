import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Real Git checkout; only remote transport is replaced to keep tests offline. */
export function gitCloneFixture(directory: string) {
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const source = join(directory, 'source');
  mkdirSync(source);
  execFileSync(binary, ['init', '-q', source]);
  writeFileSync(join(source, 'README.md'), '# Cloned project\n');
  execFileSync(binary, ['-C', source, 'add', '.']);
  execFileSync(binary, [
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'Initial project',
  ]);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  copyFileSync(resolve('tests/fixtures/git-clone.mjs'), wrapper);
  chmodSync(wrapper, 0o755);
  return {
    PATH: `${bin}:${process.env.PATH}`,
    COVRO_TEST_REAL_GIT: binary,
    COVRO_TEST_GIT_SOURCE: source,
    COVRO_TEST_GIT_CALLS: join(directory, 'git-calls'),
    COVRO_TEST_GIT_PIDS: join(directory, 'git-pids'),
    COVRO_TEST_GIT_RELEASE: join(directory, 'release'),
  };
}

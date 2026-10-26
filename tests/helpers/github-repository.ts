import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function githubCheckout(directory: string, remote = 'git@github.com:example/project.git') {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q');
  git(directory, 'remote', 'add', 'origin', remote);
  git(
    directory,
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
    'Initial',
    '--allow-empty',
  );
  return directory;
}

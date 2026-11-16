#!/usr/bin/env node
// Test-only Git transport: forward accepted remote URLs to a local repository.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { setInterval, clearInterval } from 'node:timers';
const args = process.argv.slice(2);
if (!args.includes('clone')) {
  const child = spawn(process.env.COVRO_TEST_REAL_GIT, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const repository = args.at(-2);
  const target = args.at(-1);
  if (process.env.COVRO_TEST_GIT_CALLS)
    writeFileSync(process.env.COVRO_TEST_GIT_CALLS, `${repository}\n`, { flag: 'a' });
  if (repository.includes('/auth')) {
    console.error(
      'fatal: Authentication failed for https://user:TOP_SECRET@example.test/private.git?token=HIDDEN_TOKEN',
    );
    process.exit(128);
  } else if (repository.includes('/missing')) {
    console.error('fatal: repository not found');
    process.exit(128);
  } else if (repository.includes('/slow')) {
    if (process.env.COVRO_TEST_GIT_PIDS)
      writeFileSync(process.env.COVRO_TEST_GIT_PIDS, `${process.pid}\n`, { flag: 'a' });
    console.error('Receiving objects:  42% (42/100)\r');
    const timer = setInterval(() => {
      if (
        repository.includes('/slow-success') &&
        process.env.COVRO_TEST_GIT_RELEASE &&
        existsSync(process.env.COVRO_TEST_GIT_RELEASE)
      ) {
        clearInterval(timer);
        const child = spawn(
          process.env.COVRO_TEST_REAL_GIT,
          ['clone', '--progress', '--', process.env.COVRO_TEST_GIT_SOURCE, target],
          { stdio: 'inherit' },
        );
        child.on('exit', (code) => process.exit(code ?? 1));
      }
    }, 100);
    process.on('SIGTERM', () => {
      clearInterval(timer);
      process.exit(143);
    });
  } else {
    const child = spawn(
      process.env.COVRO_TEST_REAL_GIT,
      ['clone', '--progress', '--', process.env.COVRO_TEST_GIT_SOURCE, target],
      { stdio: 'inherit' },
    );
    child.on('exit', (code) => process.exit(code ?? 1));
  }
}

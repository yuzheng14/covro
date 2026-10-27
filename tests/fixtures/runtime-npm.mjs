// Test-only npm protocol simulator; never downloads or installs external packages.
import process from 'node:process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const metadata = process.env.COVRO_TEST_RELEASE_METADATA;
if (!metadata) throw new Error('Expected isolated runtime fixture metadata');
const args = process.argv.slice(2);
const prefix = process.env.npm_config_prefix;
if (args[0] === '--version') process.stdout.write('11.0.0\n');
else if (args[0] === 'prefix') process.stdout.write(prefix + '\n');
else if (args[0] === 'root') process.stdout.write(join(prefix, 'lib/node_modules') + '\n');
else if (args[0] === 'install') {
  const staged = join(args[args.indexOf('--prefix') + 1], 'lib/node_modules/@covro/covro');
  await mkdir(dirname(staged), { recursive: true });
  await cp(join(prefix, 'lib/node_modules/@covro/covro'), staged, {
    recursive: true,
    preserveSymlinks: true,
  });
  await writeFile(join(staged, 'package.json'), await readFile(metadata));
  await writeFile(metadata + '.npm.json', JSON.stringify({ node: process.execPath, args }));
} else throw new Error('Unexpected fixture npm command');

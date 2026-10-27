import { verifyDatabaseContract } from './verify-database-contract.js';
import { npmPackageName } from '../src/shared/package.js';
import { verifyCompatibility } from './sync-compatibility.js';
verifyCompatibility();
verifyDatabaseContract();
import { execFileSync } from 'node:child_process';
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }),
) as { name: string; files: { path: string }[] }[];
const artifact = packed[0];
if (artifact?.name !== npmPackageName) throw new Error('Unexpected package');
const files = artifact.files.map((entry) => entry.path);
for (const required of [
  'bin/covro.mjs',
  'dist/cli/main.js',
  'dist/codex/compatibility.js',
  'dist/shared/codex-compatibility.js',
  'dist/shared/package.js',
  'dist/server/main.js',
  'dist/web/index.html',
  'dist/web/notification-worker.js',
  'dist/update-worker.cjs',
  'dist/drizzle/meta/_journal.json',
]) {
  if (!files.includes(required)) throw new Error(`Missing package artifact: ${required}`);
}
if (
  files.some(
    (filename) =>
      /(^|\/)(config\.local\.json|\.env(?:\..*)?|.*\.sqlite(?:-wal|-shm)?)$/.test(filename) ||
      filename.startsWith('tests/') ||
      filename.startsWith('src/'),
  )
)
  throw new Error('Package contains local state or development source');
execFileSync(process.execPath, ['bin/covro.mjs', '--help'], { stdio: 'pipe' });
console.log(
  `PASS: covro npm package includes ${files.length} intended files and a working CLI entry`,
);

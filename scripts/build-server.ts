import { cp, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
const directories = [
  'src/logging',
  'src/server',
  'src/shared',
  'src/codex',
  'src/cli',
  'src/updates',
  'src/backups',
];
const entries: string[] = [];
for (const directory of directories) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.parentPath.includes('/generated')
    )
      entries.push(`${entry.parentPath}/${entry.name}`);
  }
}
await build({
  entryPoints: entries,
  outdir: 'dist',
  outbase: 'src',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
await build({
  entryPoints: ['src/updates/worker.ts'],
  outfile: 'dist/update-worker.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
});

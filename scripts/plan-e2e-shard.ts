import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { JSONReport } from '@playwright/test/reporter';
import { collectE2eFiles, planE2eShards, verifyE2eShard } from './e2e-shards.js';

const [reportPath, indexArg, totalArg, outputPath] = process.argv.slice(2);
const index = Number(indexArg);
const total = Number(totalArg);
if (!reportPath || !outputPath || !Number.isSafeInteger(index) || index < 1 || index > total) {
  throw new Error('Usage: plan-e2e-shard.ts <list-report.json> <index> <total> <test-list.txt>');
}
const report: JSONReport = JSON.parse(readFileSync(reportPath, 'utf8'));
const timings: { durationMs: Record<string, number> } = JSON.parse(
  readFileSync(new URL('./e2e-timings.json', import.meta.url), 'utf8'),
);
const shards = planE2eShards(collectE2eFiles(report), timings.durationMs, total);
const selected = shards[index - 1]!;
mkdirSync(dirname(outputPath), { recursive: true });
// Playwright test lists require paths relative to its rootDir, as in the JSON
// report. Absolute paths silently select no tests and do not fail the run.
writeFileSync(outputPath, selected.files.map((file) => file.file).join('\n') + '\n');
const require = createRequire(import.meta.url);
const selectedReport: JSONReport = JSON.parse(
  execFileSync(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      '--list',
      `--test-list=${outputPath}`,
      '--reporter=json',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ),
);
verifyE2eShard(selected, collectE2eFiles(selectedReport));
for (const [i, shard] of shards.entries()) {
  console.log(
    `E2E shard ${i + 1}/${total}: ${shard.files.length} files, ` +
      `${shard.files.reduce((sum, file) => sum + file.tests, 0)} tests, ` +
      `estimated ${(shard.durationMs / 1000).toFixed(1)}s${i === index - 1 ? ' (selected)' : ''}`,
  );
}

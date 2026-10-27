import { readFileSync, writeFileSync } from 'node:fs';
import type { JSONReport } from '@playwright/test/reporter';
import { collectE2eFiles } from './e2e-shards.js';

const [source, ...reportPaths] = process.argv.slice(2);
if (!source || !reportPaths.length) {
  throw new Error('Usage: update-e2e-timings.ts <source> <report.json> [report.json ...]');
}
const durations = new Map<string, number[]>();
for (const path of reportPaths) {
  const report: JSONReport = JSON.parse(readFileSync(path, 'utf8'));
  if (report.stats.unexpected || report.stats.flaky || report.config.shard) {
    throw new Error(`Use successful reports without retries or native sharding: ${path}`);
  }
  const files = collectE2eFiles(report);
  if (!files.length || files.some((file) => file.durationMs <= 0)) {
    throw new Error(`Report must contain executed tests for every file: ${path}`);
  }
  for (const file of files) {
    const samples = durations.get(file.file) ?? [];
    samples.push(file.durationMs);
    durations.set(file.file, samples);
  }
}
const durationMs = Object.fromEntries(
  [...durations.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([file, samples]) => [
      file,
      Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    ]),
);
writeFileSync(
  new URL('./e2e-timings.json', import.meta.url),
  JSON.stringify({ source, durationMs }, null, 2) + '\n',
);
console.log(`Updated timings for ${durations.size} files`);

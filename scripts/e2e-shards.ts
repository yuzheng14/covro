import type { JSONReport } from '@playwright/test/reporter';

export interface E2eFile {
  file: string;
  tests: number;
  durationMs: number;
}

export interface E2eShard {
  files: E2eFile[];
  durationMs: number;
}

export function verifyE2eShard(expected: E2eShard, actual: readonly E2eFile[]): void {
  const expectedCounts = new Map(expected.files.map((file) => [file.file, file.tests]));
  if (
    actual.length !== expectedCounts.size ||
    actual.some((file) => expectedCounts.get(file.file) !== file.tests)
  ) {
    throw new Error('Playwright test-list collection differs from the planned shard');
  }
}

export function collectE2eFiles(report: Pick<JSONReport, 'suites' | 'errors'>): E2eFile[] {
  if (report.errors.length) throw new Error('Cannot shard a report with collection errors');
  const files = new Map<string, E2eFile>();
  function visit(suites: JSONReport['suites']) {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        const file = files.get(spec.file) ?? { file: spec.file, tests: 0, durationMs: 0 };
        file.tests += spec.tests.length;
        for (const test of spec.tests) {
          for (const result of test.results) file.durationMs += result.duration;
        }
        files.set(spec.file, file);
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

// Longest files go first into the lightest shard. Keep each file intact so its
// hooks and tests still run serially against that runner's fixture server.
export function planE2eShards(
  files: readonly E2eFile[],
  timings: Readonly<Record<string, number>>,
  total: number,
): E2eShard[] {
  if (!Number.isSafeInteger(total) || total < 1 || total > files.length) {
    throw new Error('Shard count must be an integer between 1 and the number of test files');
  }
  const known = files.filter((file) => timings[file.file] !== undefined);
  for (const file of known) {
    const duration = timings[file.file]!;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Invalid duration for ${file.file}`);
    }
  }
  // New and renamed files use the measured mean per test, so they are included
  // without requiring an update to the timing baseline first.
  const msPerTest = known.length
    ? known.reduce((sum, file) => sum + timings[file.file]!, 0) /
      known.reduce((sum, file) => sum + file.tests, 0)
    : 1000;
  const weighted = files.map((file) => ({
    ...file,
    durationMs: timings[file.file] ?? file.tests * msPerTest,
  }));
  weighted.sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file, 'en'));
  const shards: E2eShard[] = Array.from({ length: total }, () => ({ files: [], durationMs: 0 }));
  for (const file of weighted) {
    const shard = shards.reduce((best, next) => (next.durationMs < best.durationMs ? next : best));
    shard.files.push(file);
    shard.durationMs += file.durationMs;
  }
  for (const shard of shards) {
    shard.files.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  }
  return shards;
}

import type { JSONReport } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';
import {
  collectE2eFiles,
  planE2eShards,
  verifyE2eShard,
  type E2eFile,
} from '../../scripts/e2e-shards.js';

const file = (name: string, tests = 1): E2eFile => ({ file: name, tests, durationMs: 0 });

describe('E2E shard planning', () => {
  it('balances expensive files and includes every file exactly once regardless of input order', () => {
    const timings = { a: 90, b: 80, c: 30, d: 20, e: 10, f: 10 };
    const files = Object.keys(timings).map((name) => file(name));
    const shards = planE2eShards(files, timings, 2);
    expect(shards.map((shard) => shard.durationMs)).toEqual([120, 120]);
    expect(shards.flatMap((shard) => shard.files.map((entry) => entry.file)).sort()).toEqual(
      Object.keys(timings),
    );
    expect(planE2eShards(files.toReversed(), timings, 2)).toEqual(shards);
  });

  it('includes new and renamed files using measured time per test, ignoring removed files', () => {
    const shards = planE2eShards(
      [file('known', 10), file('new', 4), file('renamed', 6)],
      { known: 100, removed: 100_000 },
      2,
    );
    const files = shards.flatMap((shard) => shard.files);
    expect(files.find((entry) => entry.file === 'new')?.durationMs).toBe(40);
    expect(files.find((entry) => entry.file === 'renamed')?.durationMs).toBe(60);
    expect(files.map((entry) => entry.file).sort()).toEqual(['known', 'new', 'renamed']);
    expect(shards.map((shard) => shard.durationMs)).toEqual([100, 100]);
  });

  it('can plan the entire suite without historical timings', () => {
    const shards = planE2eShards([file('a', 2), file('b', 3)], {}, 1);
    expect(shards[0]?.files.map((entry) => entry.file)).toEqual(['a', 'b']);
    expect(shards[0]?.durationMs).toBe(5000);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 3])('rejects invalid or empty shard counts: %s', (total) => {
    expect(() => planE2eShards([file('a'), file('b')], {}, total)).toThrow('Shard count');
  });

  it.each([0, -1, NaN, Infinity])('rejects unusable timing data: %s', (duration) => {
    expect(() => planE2eShards([file('a')], { a: duration }, 1)).toThrow('Invalid duration');
  });

  it('rejects empty or partial native test-list collection instead of producing a green shard', () => {
    const shard = { files: [file('a', 2), file('b', 3)], durationMs: 5000 };
    expect(() => verifyE2eShard(shard, [])).toThrow('differs from the planned shard');
    expect(() => verifyE2eShard(shard, [file('a', 2), file('b', 2)])).toThrow(
      'differs from the planned shard',
    );
    expect(() => verifyE2eShard(shard, [file('a', 2), file('other', 3)])).toThrow(
      'differs from the planned shard',
    );
    expect(() => verifyE2eShard(shard, shard.files.toReversed())).not.toThrow();
  });
});

describe('Playwright report collection', () => {
  it('collects nested suites and projects into whole files, including unexecuted new tests', () => {
    // Only the report fields consumed by the collector are needed in this fixture.
    const report = {
      errors: [],
      suites: [
        {
          specs: [
            { file: 'a.spec.ts', tests: [{ results: [] }] },
            { file: 'b.spec.ts', tests: [{ results: [{ duration: 10 }] }] },
          ],
          suites: [
            {
              specs: [
                {
                  file: 'a.spec.ts',
                  tests: [{ results: [{ duration: 20 }] }, { results: [{ duration: 30 }] }],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as JSONReport;
    expect(collectE2eFiles(report)).toEqual([
      { file: 'a.spec.ts', tests: 3, durationMs: 50 },
      { file: 'b.spec.ts', tests: 1, durationMs: 10 },
    ]);
  });

  it('fails collection errors instead of silently planning a partial suite', () => {
    expect(() => collectE2eFiles({ errors: [{ message: 'load failed' }], suites: [] })).toThrow(
      'collection errors',
    );
    expect(() => planE2eShards(collectE2eFiles({ errors: [], suites: [] }), {}, 1)).toThrow(
      'Shard count',
    );
  });
});

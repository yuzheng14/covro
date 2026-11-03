import { expect, it } from 'vitest';
import { formatTokenCount } from '../../src/web/lib/context-usage';
it.each([
  [0, '0'],
  [999, '999'],
  [1000, '1K'],
  [1234, '1.2K'],
  [50000, '50K'],
  [999950, '1M'],
  [1200000, '1.2M'],
  [999950000, '1B'],
])('formats %s as %s', (count, text) => {
  expect(formatTokenCount(count as number)).toBe(text);
});
it.each([undefined, null, -1, NaN, Infinity, 0.5])(
  'keeps invalid or absent counters unknown: %s',
  (count) => {
    expect(formatTokenCount(count)).toBe('未报告');
  },
);

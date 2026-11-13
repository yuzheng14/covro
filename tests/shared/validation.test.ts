import { describe, expect, it } from 'vitest';
import { MAX_IMAGES } from '../../src/shared/images.js';
import {
  createProjectSchema,
  removeProjectSchema,
  renameProjectSchema,
  resolveActionSchema,
  startTurnSchema,
  steerSchema,
} from '../../src/shared/validation.js';

const clientOperationId = 'be1ce8c0-c87e-4a42-92cd-ef9f77e019df';

describe('interactive response contract', () => {
  it('preserves typed form values including false, zero, and exact text', () => {
    const resolution = {
      decision: 'accept',
      content: { enabled: false, count: 0, note: '  保留空白\n', channels: ['web', 'mobile'] },
    };
    expect(resolveActionSchema.parse({ clientOperationId, resolution }).resolution).toEqual(
      resolution,
    );
  });

  it('rejects invented grants and mixed response types', () => {
    for (const resolution of [
      { decision: 'accept', permissions: { network: { enabled: true } } },
      { decision: 'accept', scope: 'session' },
      { decision: 'accept', answers: {} },
      { answers: {}, content: {} },
    ]) {
      expect(resolveActionSchema.safeParse({ clientOperationId, resolution }).success).toBe(false);
    }
  });

  it('rejects nested or unbounded elicitation values at the HTTP boundary', () => {
    for (const content of [
      { nested: { enabled: true } },
      { channels: [true] },
      { empty: null },
      { note: 'x'.repeat(10_001) },
      { count: Infinity },
    ]) {
      expect(
        resolveActionSchema.safeParse({
          clientOperationId,
          resolution: { decision: 'accept', content },
        }).success,
      ).toBe(false);
    }
  });
});

describe.each([
  { name: 'start turn', schema: startTurnSchema, input: { clientOperationId } },
  {
    name: 'steer turn',
    schema: steerSchema,
    input: { clientOperationId, expectedTurnId: 'turn-1' },
  },
])('$name text contract', ({ schema, input }) => {
  it('preserves indentation, trailing whitespace, and line endings exactly', () => {
    for (const text of ['\tfirst line\n\tsecond line\n', '  第一行  \r\n  第二行\t\r\n']) {
      expect(schema.parse({ ...input, text }).text).toBe(text);
    }
  });

  it('rejects empty or whitespace-only text', () => {
    for (const text of ['', ' ', '\t\r\n', '\u3000\u00a0']) {
      expect(schema.safeParse({ ...input, text }).success).toBe(false);
    }
  });

  it('accepts inline images with or without text and rejects paths, URLs and invalid data', () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    expect(schema.parse({ ...input, text: '', images: [image] }).images).toEqual([image]);
    expect(schema.parse({ ...input, text: '  看图\n', images: [image] }).text).toBe('  看图\n');
    for (const images of [
      [],
      ['/tmp/image.png'],
      ['https://example.com/image.png'],
      ['data:image/svg+xml;base64,PHN2Zy8+'],
      ['data:image/png;base64,'],
      ['data:image/png;base64,a==='],
      Array(MAX_IMAGES + 1).fill(image),
    ]) {
      expect(schema.safeParse({ ...input, text: '', images }).success).toBe(false);
    }
    const large = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}`;
    expect(schema.safeParse({ ...input, text: '', images: [large] }).success).toBe(true);
    expect(schema.safeParse({ ...input, text: '', images: [large, large] }).success).toBe(true);
    expect(schema.safeParse({ ...input, text: 'text', images: [`${large}AA=A`] }).success).toBe(
      false,
    );
  });

  it('applies the length limit to the original text, including surrounding whitespace', () => {
    const text = ` ${'x'.repeat(99_998)}\n`;
    expect(schema.safeParse({ ...input, text }).success).toBe(true);
    expect(schema.safeParse({ ...input, text: `${text}\n` }).success).toBe(false);
  });
});

describe('project management input contract', () => {
  it('trims display names and rejects blank or overlong names', () => {
    expect(createProjectSchema.parse({ path: '/tmp/project', name: '  项目名  ' })).toEqual({
      path: '/tmp/project',
      name: '项目名',
    });
    expect(renameProjectSchema.parse({ name: '  Renamed  ' })).toEqual({ name: 'Renamed' });
    for (const name of ['', ' \t\r\n', 'x'.repeat(101)]) {
      expect(createProjectSchema.safeParse({ path: '/tmp/project', name }).success).toBe(false);
      expect(renameProjectSchema.safeParse({ name }).success).toBe(false);
    }
    expect(createProjectSchema.safeParse({ path: '/tmp/project' }).success).toBe(true);
    expect(renameProjectSchema.safeParse({}).success).toBe(false);
  });

  it('rejects path reassignment and undeclared deletion or execution options', () => {
    expect(createProjectSchema.safeParse({ path: '/tmp/project', cwd: '/tmp/other' }).success).toBe(
      false,
    );
    expect(renameProjectSchema.safeParse({ name: 'New name', path: '/tmp/other' }).success).toBe(
      false,
    );
    expect(removeProjectSchema.safeParse({ deleteFiles: true }).success).toBe(false);
    expect(removeProjectSchema.parse({})).toEqual({});
  });
});

it('accepts explicit Fast clearing while rejecting unknown service tiers', () => {
  for (const serviceTier of ['fast', null]) {
    expect(
      startTurnSchema.parse({ clientOperationId, text: 'task', settings: { serviceTier } })
        .settings,
    ).toEqual({ serviceTier });
  }
  expect(
    startTurnSchema.safeParse({
      clientOperationId,
      text: 'task',
      settings: { serviceTier: 'invented' },
    }).success,
  ).toBe(false);
});

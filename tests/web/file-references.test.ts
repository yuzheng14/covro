import { expect, it } from 'vitest';
import { fileToken, nativeFilePath, literalMessage } from '../../src/shared/file-references';
import { fileTrigger } from '../../src/web/lib/file-references';
import { editBindings, replaceReferenceRange } from '../../src/web/lib/input-references';

it('recognizes explicit paths and quoted queries while preserving literal @ and selections', () => {
  expect(fileTrigger('read @docs/中文', 13)).toMatchObject({ search: 'docs/中文', start: 5 });
  const text = 'read @"docs/中文 说';
  expect(fileTrigger(text, text.length)).toMatchObject({ search: 'docs/中文 说', start: 5 });
  for (const text of ['a@b.com', '\\@docs', '`@docs', 'foo@']) {
    expect(fileTrigger(text, text.length)).toBeUndefined();
  }
  expect(fileTrigger('@docs', 3, 5)).toBeUndefined();
});
it('keeps independent file and skill identities through edits, duplicate names and replacements', () => {
  const text = '@a/same.ts $review @b/same.ts';
  const a = { cwd: '/workspace', path: 'a/same.ts', start: 0, end: 10 };
  const b = { ...a, path: 'b/same.ts', start: 19, end: 29 };
  const skill = { name: 'review', path: '/review/SKILL.md', cwd: a.cwd, start: 11, end: 18 };
  expect(editBindings(text, 'read ' + text, [a, b])).toEqual([
    { ...a, start: 5, end: 15 },
    { ...b, start: 24, end: 34 },
  ]);
  expect(replaceReferenceRange(text, 0, 11, '', [a, b]).bindings).toEqual([
    { ...b, start: 8, end: 18 },
  ]);
  expect(replaceReferenceRange(text, 0, 11, '', [skill]).bindings).toEqual([
    { ...skill, start: 0, end: 7 },
  ]);
  expect(editBindings(text, text.replace('@a/same.ts', '@a/other.ts'), [a, b])).toHaveLength(1);
});
it('uses native quoting and rebases file positions when sending escaped slash text', () => {
  expect(nativeFilePath('中文 空格.md')).toBe('"中文 空格.md"');
  expect(fileToken('中文 空格.md')).toBe('@"中文 空格.md"');
  const file = { cwd: '/work', path: 'a.ts', start: 8, end: 13 };
  expect(literalMessage('//check @a.ts', [file])).toEqual({
    text: '/check @a.ts',
    files: [{ ...file, start: 7, end: 12 }],
  });
});

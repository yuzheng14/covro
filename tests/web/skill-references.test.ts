import { expect, it } from 'vitest';
import {
  editBindings,
  replaceSkillRange,
  selectedReferences,
  skillTrigger,
} from '../../src/web/lib/skill-references';
import { hasSkillToken } from '../../src/shared/skills';
const binding = { name: 'review', path: '/a/SKILL.md', cwd: '/workspace', start: 0, end: 7 };
it('recognizes explicit token positions without treating currencies, escapes, inline code or selections as references', () => {
  expect(skillTrigger('$rev', 4)).toEqual({ start: 0, end: 4, search: 'rev' });
  expect(skillTrigger('use ($rev', 9)?.start).toBe(5);
  for (const text of ['a$rev', '\\$rev', '$100', '`$rev', '$foo/bar'])
    expect(skillTrigger(text, text.length)).toBeUndefined();
  expect(skillTrigger('$rev', 2, 4)).toBeUndefined();
});
it('shifts untouched identities and drops bindings when a token is edited, deleted or joined to a name', () => {
  expect(editBindings('$review ok', 'do $review ok', [binding])[0]).toMatchObject({
    start: 3,
    end: 10,
  });
  expect(editBindings('$review ok', '$review! ok', [binding])).toEqual([binding]);
  expect(editBindings('$review ok', '$reviewer ok', [binding])).toEqual([]);
  expect(editBindings('$review ok', '$rev ok', [binding])).toEqual([]);
  expect(editBindings('$review ok', 'ok', [binding])).toEqual([]);
});
it('preserves duplicate-name identities and removes their token with the binding', () => {
  const other = { ...binding, path: '/b/SKILL.md', start: 8, end: 15 };
  expect(selectedReferences([binding, other])).toHaveLength(2);
  expect(replaceSkillRange('$review $review ok', 0, 8, '', [binding, other])).toEqual({
    text: '$review ok',
    skills: [{ ...other, start: 0, end: 7 }],
  });
  expect(hasSkillToken('Use ($review).', 'review')).toBe(true);
  expect(hasSkillToken('$reviewer', 'review')).toBe(false);
  expect(hasSkillToken('\\$review', 'review')).toBe(false);
});

it('uses the native caret to distinguish deleting the first of two identical tokens', () => {
  const other = { ...binding, path: '/b/SKILL.md', start: 8, end: 15 };
  expect(editBindings('$review $review ok', '$review ok', [binding, other], 0)).toEqual([
    { ...other, start: 0, end: 7 },
  ]);
});

it('treats selected skill ranges as indivisible for selection and deletion', async () => {
  const { skillDeletion, skillSelection } = await import('../../src/web/lib/skill-references');
  const other = { ...binding, path: '/b/SKILL.md', start: 8, end: 15 };
  const text = '$review $review check';
  expect(skillDeletion(text, [binding, other], 8, 8, true)).toEqual({ start: 0, end: 8 });
  expect(skillDeletion(text, [binding, other], 8, 8, false)).toEqual({ start: 8, end: 16 });
  expect(skillSelection([binding, other], 3, 12)).toEqual({ start: 0, end: 15 });
  expect(skillSelection([binding], 2, 2)).toEqual({ start: 0, end: 0 });
  expect(skillDeletion(text, [binding, other], 19, 19, true)).toBeUndefined();
});

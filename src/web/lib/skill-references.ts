import type { SkillReference } from '../../shared/skills';
export interface SkillBinding extends SkillReference {
  start: number;
  end: number;
}
export function skillTrigger(text: string, caret: number, selectionEnd = caret) {
  if (caret !== selectionEnd) return;
  const prefix = text.slice(0, caret);
  const match = /(?:^|[\s([{])\$([^\s$`\\/]*)$/u.exec(prefix);
  if (!match || /^\d/u.test(match[1]!) || (prefix.match(/`/g)?.length ?? 0) % 2) return;
  return { start: caret - match[1]!.length - 1, end: caret, search: match[1]! };
}
/** Preserve identities only when edits leave the selected token intact. */
export function editBindings(
  before: string,
  after: string,
  bindings: SkillBinding[] = [],
  caretAfter?: number,
): SkillBinding[] {
  let start = 0;
  let oldEnd = before.length,
    newEnd = after.length;
  if (caretAfter !== undefined) {
    while (newEnd > caretAfter && oldEnd > 0 && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    while (start < Math.min(oldEnd, newEnd) && before[start] === after[start]) start++;
  } else {
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
  }
  return rebaseBindings(after, bindings, start, oldEnd, newEnd);
}
function rebaseBindings(
  after: string,
  bindings: SkillBinding[],
  start: number,
  oldEnd: number,
  newEnd: number,
) {
  const delta = newEnd - oldEnd;
  return bindings.flatMap((binding) => {
    const next =
      binding.end <= start
        ? binding
        : binding.start >= oldEnd
          ? { ...binding, start: binding.start + delta, end: binding.end + delta }
          : undefined;
    if (
      !next ||
      after.slice(next.start, next.end) !== `$${next.name}` ||
      (next.start > 0 && !/[\s([{]/u.test(after[next.start - 1]!)) ||
      (next.end < after.length && !/[\s.,!?;:)\]}]/u.test(after[next.end]!))
    )
      return [];
    return [next];
  });
}
export function selectedReferences(bindings: SkillBinding[] = []): SkillReference[] {
  return [
    ...new Map(
      bindings.map(({ name, path, cwd }) => [
        JSON.stringify([name, path, cwd]),
        { name, path, cwd },
      ]),
    ).values(),
  ];
}

export function removeSkillBinding(text: string, bindings: SkillBinding[], skill: SkillReference) {
  let next = text;
  let remaining = bindings;
  for (const binding of bindings
    .filter((entry) => entry.name === skill.name && entry.path === skill.path)
    .sort((a, b) => b.start - a.start)) {
    const end = binding.end + (next[binding.end] === ' ' ? 1 : 0);
    const edited = next.slice(0, binding.start) + next.slice(end);
    remaining = rebaseBindings(edited, remaining, binding.start, end, binding.start);
    next = edited;
  }
  return { text: next, skills: remaining };
}

export function replaceSkillRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
  bindings: SkillBinding[] = [],
) {
  const next = text.slice(0, start) + replacement + text.slice(end);
  return {
    text: next,
    skills: rebaseBindings(next, bindings, start, end, start + replacement.length),
  };
}

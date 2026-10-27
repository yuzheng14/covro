import type { SkillReference } from '../../shared/skills';
export interface SkillBinding extends SkillReference {
  start: number;
  end: number;
}

/** Browser selection and deletion must never split a bound skill into literal fragments. */
export function skillSelection(bindings: SkillBinding[], start: number, end: number) {
  for (const binding of bindings) {
    if (start === end && start > binding.start && start < binding.end) {
      const boundary = start - binding.start < binding.end - start ? binding.start : binding.end;
      return { start: boundary, end: boundary };
    }
    if (start < binding.end && end > binding.start) {
      start = Math.min(start, binding.start);
      end = Math.max(end, binding.end);
    }
  }
  return { start, end };
}

export function skillDeletion(
  text: string,
  bindings: SkillBinding[],
  start: number,
  end: number,
  backward: boolean,
) {
  if (start !== end) {
    if (!bindings.some((binding) => start < binding.end && end > binding.start)) return;
    return skillSelection(bindings, start, end);
  }
  const binding = bindings.find((binding) =>
    backward
      ? start > binding.start &&
        (start <= binding.end || (start === binding.end + 1 && text[binding.end] === ' '))
      : start >= binding.start && start < binding.end,
  );
  if (!binding) return;
  return {
    start: binding.start,
    end: backward ? Math.max(end, binding.end) : binding.end + (text[binding.end] === ' ' ? 1 : 0),
  };
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

/** Show a local path or the shortest useful suffix that still distinguishes same-name skills. */
export function skillSourceLabel(
  skill: Pick<SkillReference, 'name' | 'path'>,
  cwd: string,
  peers: Pick<SkillReference, 'name' | 'path'>[],
) {
  const root = cwd.replace(/\/$/u, '') + '/';
  if (skill.path.startsWith(root)) return './' + skill.path.slice(root.length);
  const segments = skill.path.split('/');
  for (let length = 3; length < segments.length; length++) {
    const suffix = segments.slice(-length).join('/');
    if (
      !peers.some(
        (peer) =>
          peer.name === skill.name && peer.path !== skill.path && peer.path.endsWith('/' + suffix),
      )
    )
      return '…/' + suffix;
  }
  return skill.path;
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

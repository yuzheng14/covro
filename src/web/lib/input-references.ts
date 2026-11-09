import { fileToken, type FileReference } from '../../shared/file-references';
import type { SkillBinding } from './skill-references';
export type InputBinding = SkillBinding | FileReference;
export const bindingToken = (binding: InputBinding) =>
  'name' in binding ? `$${binding.name}` : fileToken(binding.path);

/** Browser selection and deletion must never split a bound reference into literal fragments. */
export function referenceSelection(bindings: InputBinding[], start: number, end: number) {
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

export function referenceDeletion(
  text: string,
  bindings: InputBinding[],
  start: number,
  end: number,
  backward: boolean,
) {
  if (start !== end) {
    if (!bindings.some((binding) => start < binding.end && end > binding.start)) return;
    return referenceSelection(bindings, start, end);
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
/** Preserve identities only when edits leave the selected token intact. */
export function editBindings<T extends InputBinding>(
  before: string,
  after: string,
  bindings: T[] = [],
  caretAfter?: number,
): T[] {
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
function rebaseBindings<T extends InputBinding>(
  after: string,
  bindings: T[],
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
      after.slice(next.start, next.end) !== bindingToken(next) ||
      (next.start > 0 && !/[\s([{]/u.test(after[next.start - 1]!)) ||
      (next.end < after.length && !/[\s.,!?;:)\]}]/u.test(after[next.end]!))
    )
      return [];
    return [next];
  });
}
export function replaceReferenceRange<T extends InputBinding>(
  text: string,
  start: number,
  end: number,
  replacement: string,
  bindings: T[] = [],
) {
  const next = text.slice(0, start) + replacement + text.slice(end);
  return {
    text: next,
    bindings: rebaseBindings(next, bindings, start, end, start + replacement.length),
  };
}

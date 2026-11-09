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

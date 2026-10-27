import type { SkillsListEntry } from '../codex/generated/v2/SkillsListEntry.js';
export type SkillCatalog = SkillsListEntry;
export type SkillMetadata = SkillCatalog['skills'][number];
export interface SkillQuery {
  projectId: string | null;
  threadId?: string;
  draftId?: string;
  forceReload?: boolean;
}
export interface SkillReference {
  name: string;
  path: string;
  cwd: string;
}
export function filterSkills(skills: SkillMetadata[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  return skills.filter((skill) =>
    [skill.name, skill.description, skill.path, skill.scope, skill.pluginId ?? ''].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
}

export function hasSkillToken(text: string, name: string) {
  const token = `$${name}`;
  let from = 0;
  for (;;) {
    const start = text.indexOf(token, from);
    if (start < 0) return false;
    const end = start + token.length;
    if (
      (start === 0 || /[\s([{]/u.test(text[start - 1]!)) &&
      (end === text.length || /[\s.,!?;:)\]}]/u.test(text[end]!))
    )
      return true;
    from = start + 1;
  }
}

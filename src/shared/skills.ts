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
}
export function filterSkills(skills: SkillMetadata[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  return skills.filter((skill) =>
    [skill.name, skill.description, skill.path, skill.scope, skill.pluginId ?? ''].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
}

import { useEffect, useRef } from 'react';
import type { SkillMetadata } from '../../shared/skills';
import type { useSkills } from '../lib/skills';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { skillSourceLabel } from '../lib/skill-references';
export function SkillReferenceMenu({
  id,
  skills,
  matches,
  selected,
  unavailable,
  onSelect,
  onChoose,
}: {
  id: string;
  skills: ReturnType<typeof useSkills>;
  matches: SkillMetadata[];
  selected: number;
  unavailable?: string;
  onSelect: (index: number) => void;
  onChoose: (skill: SkillMetadata) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, matches[selected]?.path]);
  return (
    <div className="skill-reference-menu">
      <div className="skills-toolbar">
        <strong>{t('composer:skills_title')}</strong>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('common:reload')}
          title={t('common:reload')}
          disabled={skills.loading}
          onPointerDown={(event) => event.preventDefault()}
          onClick={skills.refresh}
        >
          <Icon name="refresh" size={14} />
        </Button>
      </div>
      {unavailable || skills.error ? (
        <p className="skills-state" role="status">
          {displayMessage(unavailable ?? skills.error)}
        </p>
      ) : skills.loading ? (
        <p className="skills-state" role="status">
          {t('common:loading_2')}
        </p>
      ) : (
        <>
          {!!skills.catalog?.errors.length && (
            <p className="skills-errors" role="status">
              {t('composer:skills_partial')}
            </p>
          )}
          <div
            id={id}
            role="listbox"
            aria-label={t('composer:skills_title')}
            className="skill-options"
          >
            {matches.map((skill, index) => (
              <button
                key={JSON.stringify([skill.name, skill.path])}
                ref={index === selected ? selectedRef : undefined}
                id={`${id}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                className="skill-option"
                title={skill.path}
                aria-label={`$${skill.name} · ${t(`composer:skills_scope_${skill.scope}`)} · ${skill.path}`}
                aria-description={skill.description}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') onSelect(index);
                }}
                onClick={() => onChoose(skill)}
              >
                <span className="skill-mark">
                  <Icon name="skill" size={16} />
                </span>
                <span className="skill-option-content">
                  <span className="skills-name">
                    <strong>${skill.name}</strong>
                    <span className="skills-scope">
                      {t(`composer:skills_scope_${skill.scope}`)}
                    </span>
                  </span>
                  <span className="skill-option-description">{skill.description}</span>
                  <span className="skill-option-path">
                    {skillSourceLabel(skill, skills.catalog?.cwd ?? '', matches)}
                  </span>
                </span>
                {index === selected && (
                  <span className="skill-option-selected">
                    <Icon name="check" size={15} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p className="skills-state" role="status">
              {t('composer:skills_no_match')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

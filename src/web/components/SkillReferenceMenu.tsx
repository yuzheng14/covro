import { useEffect, useRef } from 'react';
import type { SkillMetadata } from '../../shared/skills';
import type { useSkills } from '../lib/skills';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { Button } from './ui/button';
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
    <div className="slash-menu skill-reference-menu">
      <div className="skills-toolbar">
        <strong>{t('composer:skills_title')}</strong>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onPointerDown={(event) => event.preventDefault()}
          onClick={skills.refresh}
        >
          {t('common:reload')}
        </Button>
      </div>
      {unavailable || skills.error ? (
        <p role="status">{displayMessage(unavailable ?? skills.error)}</p>
      ) : skills.loading ? (
        <p role="status">{t('common:loading_2')}</p>
      ) : (
        <>
          {!!skills.catalog?.errors.length && <p role="status">{t('composer:skills_partial')}</p>}
          <div
            id={id}
            role="listbox"
            aria-label={t('composer:skills_title')}
            className="slash-options"
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
                className="slash-option"
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') onSelect(index);
                }}
                onClick={() => onChoose(skill)}
              >
                <strong>${skill.name}</strong>
                <span>{skill.description}</span>
                <span className="skills-path">
                  {t(`composer:skills_scope_${skill.scope}`)} · {skill.path}
                </span>
              </button>
            ))}
          </div>
          {!matches.length && <p role="status">{t('composer:skills_no_match')}</p>}
        </>
      )}
    </div>
  );
}

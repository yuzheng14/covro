import { useState } from 'react';
import { filterSkills } from '../../shared/skills';
import type { useSkills } from '../lib/skills';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';

export function SkillsBrowser({
  skills,
  unavailable,
  onClose,
}: {
  skills: ReturnType<typeof useSkills>;
  unavailable?: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const matches = filterSkills(skills.catalog?.skills ?? [], search);
  return (
    <CommandDialog open title={t('composer:skills_title')} onClose={onClose}>
      <div className="skills-toolbar">
        <input
          type="search"
          autoFocus
          aria-label={t('composer:skills_search')}
          placeholder={t('composer:skills_search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button size="sm" variant="secondary" onClick={skills.refresh} disabled={skills.loading}>
          {t('common:reload')}
        </Button>
      </div>
      {unavailable ? (
        <p role="status">{unavailable}</p>
      ) : skills.error ? (
        <p role="alert">{displayMessage(skills.error)}</p>
      ) : skills.loading ? (
        <p role="status">{t('common:loading_2')}</p>
      ) : (
        skills.catalog && (
          <>
            <p className="skills-path">{skills.catalog.cwd}</p>
            {!!skills.catalog.errors.length && (
              <details className="skills-errors" open>
                <summary>{t('composer:skills_partial')}</summary>
                {skills.catalog.errors.map((error, index) => (
                  <p key={index}>
                    {error.path}: {error.message}
                  </p>
                ))}
              </details>
            )}
            {!matches.length && (
              <p role="status">
                {t(
                  skills.catalog.skills.length
                    ? 'composer:skills_no_match'
                    : 'composer:skills_empty',
                )}
              </p>
            )}
            <ul className="skills-list">
              {matches.map((skill) => (
                <li key={JSON.stringify([skill.name, skill.path])}>
                  <details>
                    <summary>
                      <strong>{skill.name}</strong>
                      <span>
                        {t(`composer:skills_scope_${skill.scope}`)} ·{' '}
                        {t(skill.enabled ? 'composer:skills_enabled' : 'composer:skills_disabled')}
                      </span>
                    </summary>
                    <p className="skills-description">{skill.description}</p>
                    <p className="skills-path">{skill.path}</p>
                    {skill.pluginId && <p className="skills-path">{skill.pluginId}</p>}
                  </details>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </CommandDialog>
  );
}

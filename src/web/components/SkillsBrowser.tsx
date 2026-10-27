import { useState } from 'react';
import { filterSkills } from '../../shared/skills';
import type { useSkills } from '../lib/skills';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';
import { Icon } from './Icon';

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
    <CommandDialog
      open
      title={t('composer:skills_title')}
      onClose={onClose}
      className="skills-browser"
    >
      <div className="skills-toolbar">
        <label className="skills-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            autoFocus
            aria-label={t('composer:skills_search')}
            placeholder={t('composer:skills_search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Button
          size="icon"
          variant="ghost"
          onClick={skills.refresh}
          disabled={skills.loading}
          aria-label={t('common:reload')}
          title={t('common:reload')}
        >
          <Icon name="refresh" size={16} />
        </Button>
      </div>
      {unavailable ? (
        <p className="skills-state" role="status">
          {unavailable}
        </p>
      ) : skills.error ? (
        <p className="skills-state" role="alert">
          {displayMessage(skills.error)}
        </p>
      ) : skills.loading ? (
        <p className="skills-state" role="status">
          {t('common:loading_2')}
        </p>
      ) : (
        skills.catalog && (
          <>
            <details className="skills-workspace">
              <summary title={skills.catalog.cwd}>
                <Icon name="folder" size={14} />
                <span>
                  {skills.catalog.cwd.split('/').filter(Boolean).at(-1) ?? skills.catalog.cwd}
                </span>
                <Icon name="down" size={12} />
              </summary>
              <p className="skills-path">{skills.catalog.cwd}</p>
            </details>
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
              <p className="skills-state" role="status">
                {t(
                  skills.catalog.skills.length
                    ? 'composer:skills_no_match'
                    : 'composer:skills_empty',
                )}
              </p>
            )}
            <ul className="skills-list">
              {matches.map((skill) => (
                <li key={JSON.stringify([skill.name, skill.path])} data-enabled={skill.enabled}>
                  <details>
                    <summary>
                      <span className="skill-mark">
                        <Icon name="skill" size={18} />
                      </span>
                      <span className="skills-summary">
                        <span className="skills-name">
                          <strong>{skill.name}</strong>
                          <span className="skills-scope">
                            {t(`composer:skills_scope_${skill.scope}`)}
                          </span>
                        </span>
                        <span className="skills-description">{skill.description}</span>
                      </span>
                      <span className="skills-availability">
                        <span />
                        {t(skill.enabled ? 'composer:skills_enabled' : 'composer:skills_disabled')}
                      </span>
                      <span className="skills-chevron">
                        <Icon name="chevron" size={14} />
                      </span>
                    </summary>
                    <div className="skills-source">
                      <p className="skills-path">{skill.path}</p>
                      {skill.pluginId && <p className="skills-path">{skill.pluginId}</p>}
                    </div>
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

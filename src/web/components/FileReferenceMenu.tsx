import { useEffect, useRef } from 'react';
import type { useFileSearch } from '../lib/file-references';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function FileReferenceMenu({
  id,
  search,
  selected,
  unavailable,
  emptyQuery,
  onSelect,
  onChoose,
}: {
  id: string;
  search: ReturnType<typeof useFileSearch>;
  selected: number;
  unavailable?: string;
  emptyQuery: boolean;
  onSelect: (index: number) => void;
  onChoose: (path: string) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const paths = search.result?.paths ?? [];
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, paths[selected]]);
  return (
    <div className="skill-reference-menu file-reference-menu">
      <div className="skills-toolbar">
        <strong>{t('composer:files_title')}</strong>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('common:reload')}
          disabled={search.loading || Boolean(unavailable) || emptyQuery}
          onPointerDown={(event) => event.preventDefault()}
          onClick={search.refresh}
        >
          <Icon name="refresh" size={14} />
        </Button>
      </div>
      {unavailable || search.error ? (
        <p className="skills-state" role="status">
          {displayMessage(unavailable ?? search.error)}
        </p>
      ) : search.loading ? (
        <p className="skills-state" role="status">
          {t('common:loading_2')}
        </p>
      ) : (
        <>
          <div
            id={id}
            role="listbox"
            aria-label={t('composer:files_title')}
            className="skill-options"
          >
            {paths.map((path, index) => (
              <button
                key={path}
                id={`${id}-${index}`}
                type="button"
                role="option"
                ref={index === selected ? selectedRef : undefined}
                tabIndex={-1}
                aria-selected={index === selected}
                className="skill-option file-option"
                title={path}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={(event) => {
                  if (event.pointerType === 'mouse') onSelect(index);
                }}
                onClick={() => onChoose(path)}
              >
                <span aria-hidden="true">@</span>
                <span>{path}</span>
                {index === selected && (
                  <span className="skill-option-selected">
                    <Icon name="check" size={15} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {(!paths.length || search.result?.limited) && (
            <p className="skills-state" role="status">
              {t(
                emptyQuery
                  ? 'composer:files_type_path'
                  : search.result?.limited
                    ? 'composer:files_limited'
                    : 'composer:files_no_match',
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}

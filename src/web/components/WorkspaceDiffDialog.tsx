import { useEffect, useState } from 'react';
import type { WorkspaceDiff } from '../../shared/workspace-diff';
import { t, formatDate } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { request } from '../lib/api';
import { readableError } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
import { DiffContent } from './DiffPreview';
import { Button } from './ui/button';

export function WorkspaceDiffDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [value, setValue] = useState<WorkspaceDiff>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [section, setSection] = useState<'staged' | 'unstaged' | 'untracked'>('unstaged');
  useEffect(() => {
    const controller = new AbortController();
    setValue(undefined);
    setError(undefined);
    void request<WorkspaceDiff>(path, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      });
    return () => controller.abort();
  }, [path, attempt]);
  return (
    <CommandDialog open title={t('commands:workspaceDiff')} onClose={onClose} wide>
      <div className="diff-list-toolbar">
        <div role="group" aria-label={t('commands:diffSection')}>
          {(['staged', 'unstaged', 'untracked'] as const).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={kind === section ? 'secondary' : 'ghost'}
              aria-pressed={kind === section}
              onClick={() => setSection(kind)}
            >
              {t(`commands:diff_${kind}`)}
            </Button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          {t('common:reload')}
        </Button>
      </div>
      {error ? (
        <p role="alert">{displayMessage(error)}</p>
      ) : value ? (
        <>
          <p className="file-preview-path">
            {value.cwd} ·{' '}
            {formatDate(new Date(value.readAt), { dateStyle: 'short', timeStyle: 'medium' })}
          </p>
          {value.truncated && (
            <p className="diff-warning" role="status">
              {t('commands:diffPartial')}
            </p>
          )}
          <DiffContent
            key={`${attempt}:${section}`}
            showScope={false}
            target={{
              scope: t(`commands:diff_${section}`),
              ...(section === 'untracked'
                ? { changes: value.untracked }
                : { text: value[section] }),
            }}
          />
        </>
      ) : (
        <p role="status">{t('preview:loading_changes')}</p>
      )}
    </CommandDialog>
  );
}

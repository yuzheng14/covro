import { useEffect, useState } from 'react';
import type { GuardianDenial } from '../../shared/guardian-denials';
import { t } from '../i18n';
import { request } from '../lib/api';
import { readableError } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';

export function GuardianDenialsDialog({
  threadId,
  onChoose,
  disabled,
}: {
  threadId: string;
  onChoose: (id?: string) => void;
  disabled: boolean;
}) {
  const [entries, setEntries] = useState<GuardianDenial[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const entry = entries?.find((value) => value.id === selected);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ data: GuardianDenial[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/denials`,
      undefined,
      controller.signal,
    )
      .then(({ data }) => {
        if (!controller.signal.aborted) setEntries(data);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      });
    return () => controller.abort();
  }, [threadId]);
  return (
    <CommandDialog open title={t('commands:approveTitle')} onClose={() => onChoose()}>
      {error ? (
        <p role="alert">{error}</p>
      ) : !entries ? (
        <p role="status">{t('common:loading')}</p>
      ) : !entries.length ? (
        <p>{t('commands:approveEmpty')}</p>
      ) : (
        <>
          <label className="project-field">
            <span className="sr-only">{t('commands:approveTitle')}</span>
            <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
              <option value="">{t('commands:approveSelect')}</option>
              {entries.map((value) => (
                <option value={value.id} key={value.id}>
                  {value.review.actionSummary.slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
          {entry && (
            <>
              <pre className="command-action-content">{entry.review.actionSummary}</pre>
              {entry.review.cwd && <p className="file-preview-path">{entry.review.cwd}</p>}
              <p>{entry.review.rationale}</p>
              <p>{t('commands:approveConfirm')}</p>
            </>
          )}
        </>
      )}
      <div className="project-dialog-actions">
        <Button variant="ghost" onClick={() => onChoose()}>
          {t('commands:cancelDialog')}
        </Button>
        <Button disabled={disabled || !entry} onClick={() => entry && onChoose(entry.id)}>
          {t('commands:approveOnce')}
        </Button>
      </div>
    </CommandDialog>
  );
}

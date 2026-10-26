import { useState } from 'react';
import type { ReviewTarget } from '../../shared/types';
import { t } from '../i18n';
import { CommandDialog } from './CommandDialog';
import { Button } from './ui/button';

export function ReviewTargetDialog({
  open,
  onChoose,
  disabled,
}: {
  open: boolean;
  disabled: boolean;
  onChoose: (target?: ReviewTarget) => void;
}) {
  const [kind, setKind] = useState<ReviewTarget['type']>('uncommittedChanges');
  const [branch, setBranch] = useState('');
  const [sha, setSha] = useState('');
  const [instructions, setInstructions] = useState('');
  return (
    <CommandDialog open={open} title={t('commands:reviewTarget')} onClose={() => onChoose()}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          onChoose(
            kind === 'baseBranch'
              ? { type: kind, branch: branch.trim() }
              : kind === 'commit'
                ? { type: kind, sha: sha.trim() }
                : kind === 'custom'
                  ? { type: kind, instructions: instructions.trim() }
                  : { type: kind },
          );
        }}
      >
        <label className="project-field">
          <span className="sr-only">{t('commands:reviewTarget')}</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as ReviewTarget['type'])}
          >
            <option value="uncommittedChanges">{t('commands:reviewUncommitted')}</option>
            <option value="baseBranch">{t('commands:reviewBranch')}</option>
            <option value="commit">{t('commands:reviewCommit')}</option>
            <option value="custom">{t('commands:reviewCustom')}</option>
          </select>
        </label>
        {kind === 'baseBranch' && (
          <label className="project-field">
            <span>{t('commands:branchName')}</span>
            <input
              required
              maxLength={256}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              autoComplete="off"
            />
          </label>
        )}
        {kind === 'commit' && (
          <label className="project-field">
            <span>Commit SHA</span>
            <input
              required
              pattern="[a-fA-F0-9]{7,64}"
              maxLength={64}
              value={sha}
              onChange={(e) => setSha(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        {kind === 'custom' && (
          <label className="project-field">
            <span>{t('commands:reviewInstructions')}</span>
            <textarea
              required
              maxLength={100000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
        )}
        <div className="project-dialog-actions">
          <Button type="button" variant="ghost" onClick={() => onChoose()}>
            {t('commands:cancelDialog')}
          </Button>
          <Button type="submit" disabled={disabled}>
            {t('commands:startReview')}
          </Button>
        </div>
      </form>
    </CommandDialog>
  );
}

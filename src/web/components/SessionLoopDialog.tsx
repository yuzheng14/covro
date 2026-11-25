import { useState, type FormEvent } from 'react';
import { parseSessionLoop } from '../../shared/session-loop';
import type { ThreadView } from '../../shared/types';
import { sessionLoopsPath, useSessionLoops, type RunLoopOperation } from '../hooks/useSessionLoops';
import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { CommandDialog } from './CommandDialog';
import { SessionLoopRow } from './SessionLoopRow';
import { isActive } from './Status';
import { Button } from './ui/button';

export function SessionLoopDialog({
  thread,
  onClose,
  run,
  disabled,
}: {
  thread: ThreadView;
  onClose: () => void;
  run: RunLoopOperation;
  disabled: boolean;
}) {
  const path = sessionLoopsPath(thread.id);
  const { loops, error, controlsDisabled, setActionError, submit, control } = useSessionLoops(
    path,
    run,
  );
  const [creating, setCreating] = useState(false);
  const [interval, setIntervalText] = useState('5m');
  const [prompt, setPrompt] = useState('');

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSessionLoop(`${interval} ${prompt}`);
    if (!parsed) {
      setActionError(t('commands:loopInvalid'));
      return;
    }
    if (await submit(thread.id, path, parsed)) {
      setCreating(false);
      setPrompt('');
    }
  }

  const canCreate =
    !disabled &&
    thread.managed &&
    !thread.archived &&
    (thread.hasMessages ||
      thread.turns.some((turn) => ['completed', 'failed', 'interrupted'].includes(turn.status)));
  return (
    <CommandDialog open wide title={t('commands:loopTitle')} onClose={onClose}>
      {error && <p role="alert">{displayMessage(error)}</p>}
      <div className="session-loop-list" aria-live="polite">
        {loops?.length === 0 && <p>{t('commands:loopEmpty')}</p>}
        {loops?.map((loop) => (
          <SessionLoopRow
            key={loop.id}
            loop={loop}
            archived={Boolean(thread.archived)}
            waiting={
              loop.status === 'active' &&
              loop.nextRunAt <= Date.now() &&
              (isActive(thread.status) || Boolean(thread.execution && !thread.execution.ended))
            }
            disabled={disabled || controlsDisabled}
            onControl={(action) => void control(loop, action)}
          />
        ))}
      </div>
      {creating ? (
        <form onSubmit={(event) => void create(event)} className="session-loop-create">
          <label className="project-field">
            <span>{t('commands:loopInterval')}</span>
            <input
              required
              value={interval}
              onChange={(event) => setIntervalText(event.target.value)}
            />
          </label>
          <label className="project-field">
            <span>{t('commands:loopPrompt')}</span>
            <textarea
              required
              value={prompt}
              rows={3}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={!canCreate || controlsDisabled}>
            {t('commands:loopCreate')}
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={!canCreate || controlsDisabled}
          onClick={() => setCreating(true)}
        >
          {t('commands:loopNew')}
        </Button>
      )}
    </CommandDialog>
  );
}

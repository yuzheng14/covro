import { useEffect, useState, type FormEvent } from 'react';
import {
  LOOP_DEFAULT_HOURS,
  LOOP_DEFAULT_RUNS,
  LOOP_MAX_HOURS,
  LOOP_MAX_RUNS,
  parseSessionLoop,
  type SessionLoop,
  type SessionLoopAction,
} from '../../shared/session-loop';
import type { Operation, ThreadView } from '../../shared/types';
import { formatDate, t } from '../i18n';
import { request } from '../lib/api';
import { readableError } from '../lib/utils';
import { CommandDialog } from './CommandDialog';
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
  run: (path: string, body: object) => Promise<Operation | undefined>;
  disabled: boolean;
}) {
  const path = `/api/threads/${encodeURIComponent(thread.id)}/loops`;
  const [loops, setLoops] = useState<SessionLoop[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [interval, setIntervalText] = useState('5m');
  const [prompt, setPrompt] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await request<SessionLoop[]>(path, undefined, controller.signal);
        if (!controller.signal.aborted) setLoops(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(readableError(failure));
      } finally {
        if (!controller.signal.aborted) timeout = setTimeout(() => void refresh(), 2_000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [path, revision]);

  async function submit(endpoint: string, body: object) {
    if (busy || disabled) return false;
    setBusy(true);
    setError(undefined);
    try {
      const operation = await run(endpoint, body);
      return operation?.status === 'acknowledged';
    } catch (failure) {
      setError(readableError(failure));
      return false;
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = parseSessionLoop(`${interval} ${prompt}`);
    const lifetimeHours = Number(values.get('lifetimeHours'));
    if (!parsed || lifetimeHours * 3_600_000 <= parsed.intervalMs) {
      setError(t('commands:loopInvalid'));
      return;
    }
    if (await submit(path, { ...parsed, lifetimeHours, maxRuns: Number(values.get('maxRuns')) })) {
      setCreating(false);
      setPrompt('');
    }
  }

  function control(loop: SessionLoop, action: SessionLoopAction) {
    void submit(`${path}/${encodeURIComponent(loop.id)}`, { action, version: loop.version });
  }

  const canCreate =
    !disabled &&
    thread.managed &&
    !thread.archived &&
    (thread.hasMessages ||
      thread.turns.some((turn) => ['completed', 'failed', 'interrupted'].includes(turn.status)));
  return (
    <CommandDialog open wide title={t('commands:loopTitle')} onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      <div className="session-loop-list" aria-live="polite">
        {loops?.length === 0 && <p>{t('commands:loopEmpty')}</p>}
        {loops?.map((loop) => {
          const pending =
            loop.status === 'active' &&
            loop.nextRunAt <= Date.now() &&
            (isActive(thread.status) || Boolean(thread.execution && !thread.execution.ended));
          return (
            <article key={loop.id} className="session-loop-row">
              <p className="session-loop-prompt">{loop.prompt}</p>
              <p>
                {t(`commands:loop_${loop.status}`)} ·{' '}
                {t('commands:loopCadence', {
                  minutes: loop.intervalMs / 60_000,
                })}{' '}
                · {t('commands:loopRuns', { runs: loop.runs, max: loop.maxRuns })}
              </p>
              <p>
                {loop.lastResult && (
                  <>
                    {t('commands:loopLast', { result: t(`commands:loop_${loop.lastResult}`) })}{' '}
                    ·{' '}
                  </>
                )}
                {loop.status === 'active' &&
                  (pending
                    ? t('commands:loopWaiting')
                    : t('commands:loopNext', { time: loopDate(loop.nextRunAt) }))}
                {loop.status === 'active' && ' · '}
                {t('commands:loopExpires', { time: loopDate(loop.expiresAt) })}
              </p>
              {loop.reason && <p>{t(`commands:loopReason_${loop.reason}`)}</p>}
              {(loop.status === 'active' || loop.status === 'paused') && (
                <div className="session-loop-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={
                      busy ||
                      disabled ||
                      (loop.status === 'paused' &&
                        (thread.archived || loop.lastResult === 'unknown'))
                    }
                    onClick={() => control(loop, loop.status === 'active' ? 'pause' : 'resume')}
                  >
                    {t(loop.status === 'active' ? 'commands:loopPause' : 'commands:loopResume')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || disabled}
                    onClick={() => control(loop, 'cancel')}
                  >
                    {t('commands:loopCancel')}
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {creating ? (
        <form onSubmit={(event) => void create(event)} className="session-loop-create">
          <div className="session-loop-fields">
            <label className="project-field">
              <span>{t('commands:loopInterval')}</span>
              <input
                required
                value={interval}
                onChange={(event) => setIntervalText(event.target.value)}
              />
            </label>
            <label className="project-field">
              <span>{t('commands:loopHours')}</span>
              <input
                name="lifetimeHours"
                type="number"
                min={1}
                max={LOOP_MAX_HOURS}
                required
                defaultValue={LOOP_DEFAULT_HOURS}
              />
            </label>
            <label className="project-field">
              <span>{t('commands:loopMaxRuns')}</span>
              <input
                name="maxRuns"
                type="number"
                min={1}
                max={LOOP_MAX_RUNS}
                required
                defaultValue={LOOP_DEFAULT_RUNS}
              />
            </label>
          </div>
          <label className="project-field">
            <span>{t('commands:loopPrompt')}</span>
            <textarea
              required
              value={prompt}
              rows={3}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={!canCreate || busy}>
            {t('commands:loopCreate')}
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={!canCreate || busy}
          onClick={() => setCreating(true)}
        >
          {t('commands:loopNew')}
        </Button>
      )}
    </CommandDialog>
  );
}

function loopDate(timestamp: number): string {
  return formatDate(new Date(timestamp), { dateStyle: 'short', timeStyle: 'short' });
}

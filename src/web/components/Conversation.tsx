import { ModelCapacityNotice } from './ModelCapacityNotice';
import { isCapacityTurnError, upstreamRetryAttempt } from '../../shared/turn-errors';
import { message, displayMessage } from '../i18n/messages';
import { t, currentLocale } from '../i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AsyncQuestionReply, ItemView, ThreadView, TurnView } from '../../shared/types';
import { AsyncQuestionCard, type AsyncQuestionControls } from './AsyncQuestionCard';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive, Status } from './Status';
import { AutoReviewCard } from './AutoReviewCard';
import { CollapsibleActivity } from './CollapsibleActivity';
import { CommandOutputCopyButton } from './CommandOutputCopyButton';
import { ActivityGroup } from './ActivityGroup';
import { groupConversationItems } from '../lib/activity-groups';
import { ContextCompaction } from './ContextCompaction';
import { TurnCompletion } from './TurnCompletion';

import { MarkdownContent as TextContent } from './MarkdownContent';
import { ImagePreviewProvider } from './ImagePreview';
import { UserMessage } from './UserMessage';
import { StickyPrompt } from './StickyPrompt';
import { useDiffPreview } from './FilePreviewProvider';

const activityLabels: Record<string, string> = {
  get commandExecution() {
    return t('common:run_command');
  },
  get fileChange() {
    return t('conversation:file_changes');
  },
  get reasoning() {
    return t('conversation:reasoning');
  },
  get mcpToolCall() {
    return t('conversation:tool_call');
  },
  get webSearch() {
    return t('conversation:web_search');
  },
  get plan() {
    return t('conversation:execution_plan');
  },
  get enteredReviewMode() {
    return t('conversation:start_code_review');
  },
  get exitedReviewMode() {
    return t('conversation:code_review_results');
  },
};
const activityStatusLabels: Record<string, string> = {
  get completed() {
    return t('common:completed');
  },
  get inProgress() {
    return t('common:running');
  },
  get running() {
    return t('common:running');
  },
  get failed() {
    return t('common:failed');
  },
  get declined() {
    return t('common:denied');
  },
  get interrupted() {
    return t('common:interrupted');
  },
};

function Activity({ item, streaming }: { item: ItemView; streaming: boolean }) {
  const openDiff = useDiffPreview();
  return (
    <CollapsibleActivity
      className={`activity${item.type === 'commandExecution' ? ' activity-command' : ''}${item.status === 'failed' ? ' activity-failed' : ''}`}
      label={
        item.command
          ? t('conversation:activityWithCommand', {
              label: activityLabels[item.type] ?? item.type,
              command: item.command,
            })
          : (activityLabels[item.type] ?? item.type)
      }
      summary={
        <>
          <Icon name={item.type === 'fileChange' ? 'code' : 'terminal'} size={16} />
          <span className="activity-description">
            <span className="activity-label">{activityLabels[item.type] ?? item.type}</span>
            {item.command && <code className="command-summary">{item.command}</code>}
          </span>
          <span className="activity-status">
            {item.status ? (activityStatusLabels[item.status] ?? item.status) : ''}
          </span>
        </>
      }
    >
      <div className="activity-body">
        {item.cwd && <p className="mono subtle">{item.cwd}</p>}
        {item.command && (
          <pre className="command">
            <code>$ {item.command}</code>
          </pre>
        )}
        {item.text && <TextContent text={item.text} streaming={streaming} />}
        {item.output !== undefined &&
          (item.type === 'commandExecution' ? (
            <div className="command-output">
              <CommandOutputCopyButton output={item.output} truncated={item.truncated} />
              <pre className="tool-output" tabIndex={0}>
                <code>{item.output || t('conversation:no_output_yet')}</code>
              </pre>
            </div>
          ) : (
            <pre className="tool-output">
              <code>{item.output || t('conversation:no_output_yet')}</code>
            </pre>
          ))}
        {item.truncated && (
          <p className="truncation">
            <Icon name="alert" size={14} />
            {t('conversation:output_exceeds_the_display_limit_and_has_been')}
          </p>
        )}
        {item.changes?.map((change, index) => (
          <Button
            className="file-change-link"
            variant="ghost"
            key={`${change.path}:${index}`}
            onClick={() =>
              openDiff({
                id: item.id,
                scope: message('conversation:file_changes_from_this_tool'),
                source: 'item',
                selectedPath: change.path,
              })
            }
          >
            <Icon name="code" size={15} />
            <code>{change.path}</code>
            <span>{t('conversation:view_changes')}</span>
            <Icon name="chevron" size={14} />
          </Button>
        ))}
        {item.error && <p className="inline-error">{displayMessage(item.error)}</p>}
        {item.details !== undefined && (
          <details className="raw-details">
            <summary>{t('conversation:activity_details')}</summary>
            <pre>{JSON.stringify(item.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </CollapsibleActivity>
  );
}

function Item({
  item,
  questionControls,
  replies,
  streaming = false,
}: {
  item: ItemView;
  questionControls?: AsyncQuestionControls;
  replies?: AsyncQuestionReply[];
  streaming?: boolean;
}) {
  if (item.type === 'contextCompaction') {
    return item.status === 'inProgress' ? null : <ContextCompaction item={item} />;
  }
  if (item.type === 'userMessage') return <UserMessage item={item} />;
  if (item.type === 'autoApprovalReview' && item.autoReview) {
    return <AutoReviewCard review={item.autoReview} />;
  }
  if (item.type === 'agentMessage' || item.type === 'exitedReviewMode') {
    return (
      <article className="message assistant-message" aria-label={t('conversation:codex_reply')}>
        <div className="message-content">
          {item.type === 'agentMessage' && item.questions?.length ? (
            <AsyncQuestionCard
              itemId={item.id}
              questions={item.questions}
              replies={replies}
              disabled={questionControls?.disabled ?? true}
              onReply={questionControls?.onReply ?? (async () => false)}
            />
          ) : (
            <TextContent text={item.text ?? ''} streaming={streaming} />
          )}
          {item.error && <p className="inline-error">{displayMessage(item.error)}</p>}
        </div>
      </article>
    );
  }
  return <Activity item={item} streaming={streaming} />;
}

function CodexReconnectNotice({ turn, offline }: { turn: TurnView; offline: boolean }) {
  if (!turn.reconnect || isCapacityTurnError(turn)) return null;
  const retrying = turn.reconnect.status === 'retrying';
  const attempt = retrying ? upstreamRetryAttempt(turn.reconnect.message) : undefined;
  return (
    <div
      className={`codex-reconnect codex-reconnect-${turn.reconnect.status}`}
      data-testid="codex-reconnect-status"
      data-state={turn.reconnect.status}
      role={retrying ? 'status' : 'alert'}
      aria-label={t('conversation:codex_connection_status')}
    >
      <Icon name={retrying ? 'refresh' : 'alert'} size={18} />
      <div className="codex-reconnect-content">
        <strong>
          {offline && t('common:last_known')}
          {retrying ? t('conversation:reconnecting') : t('conversation:codex_reconnection_failed')}
          {attempt && (
            <span className="codex-retry-attempt">{t('conversation:retry_attempt', attempt)}</span>
          )}
        </strong>
        <p>
          {retrying
            ? t('conversation:reconnecting_to_the_model_service_codex_will_retry')
            : isActive(turn.status)
              ? t('conversation:codex_stopped_retrying_check_the_server_network_and')
              : t('conversation:codex_stopped_retrying_check_the_server_network_and_2')}
        </p>
        <details>
          <summary>{t('conversation:connection_details')}</summary>
          <p className="codex-reconnect-message">{displayMessage(turn.reconnect.message)}</p>
          {turn.reconnect.errorDetails && (
            <p className="codex-reconnect-message">{turn.reconnect.errorDetails}</p>
          )}
        </details>
      </div>
    </div>
  );
}

function TurnErrorNotice({ turn, offline }: { turn: TurnView; offline: boolean }) {
  if (isCapacityTurnError(turn)) {
    const retrying = turn.reconnect?.status === 'retrying';
    const attempt = retrying ? upstreamRetryAttempt(turn.reconnect!.message) : undefined;
    const details = [
      turn.reconnect?.message ?? turn.error,
      turn.reconnect?.errorDetails ?? turn.errorDetails,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    return (
      <ModelCapacityNotice
        offline={offline}
        retrying={retrying}
        state={turn.reconnect?.status ?? 'failed'}
        details={details}
        progress={
          retrying
            ? attempt
              ? t('conversation:retry_progress', attempt)
              : t('conversation:retrying_short')
            : t('conversation:retry_stopped_short')
        }
      />
    );
  }
  return turn.error &&
    turn.reconnect?.status !== 'failed' &&
    !turn.items.some((item) => item.type === 'contextCompaction' && item.error === turn.error) ? (
    <div className="error-banner">{displayMessage(turn.error)}</div>
  ) : null;
}

interface ConversationProps {
  thread?: ThreadView;
  offline: boolean;
  history?: {
    cached?: boolean;
    cacheExhausted?: boolean;
    onLoadCachedOlder?: () => void;
    syncError?: string;
    loading: boolean;
    error?: string;
    onLoadOlder: () => void;
    opening: boolean;
    openingError?: string;
    onRetryOpen: () => void;
  };
  projectName?: string;
  needsProject?: boolean;
  canAddProject?: boolean;
  onAddProject?: () => void;
  questionControls?: AsyncQuestionControls;
  readingEnabled?: boolean;
  onReadCompleted?: (threadId: string, turnId: string) => void;
}

export function Conversation(props: ConversationProps) {
  // A thread change releases image requests, sticky prompts and modal focus state.
  return (
    <ImagePreviewProvider key={props.thread?.id ?? 'empty'} threadId={props.thread?.id}>
      <ConversationContent {...props} />
    </ImagePreviewProvider>
  );
}

function ConversationContent({
  thread,
  offline,
  history,
  projectName,
  needsProject = false,
  canAddProject = true,
  onAddProject,
  readingEnabled = true,
  onReadCompleted,
  questionControls,
}: ConversationProps) {
  const openDiff = useDiffPreview();
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showBottom, setShowBottom] = useState(false);
  const previousThread = useRef(thread?.id);
  const lastReadCompletion = useRef<{ threadId: string; turnId: string } | undefined>(undefined);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const lastScrollTop = useRef(0);
  const scrollingUp = useRef(false);
  const userScrolled = useRef(false);
  const latestTurn = thread?.turns.at(-1);
  const questionReplies = new Map<string, AsyncQuestionReply[]>();
  for (const turn of thread?.turns ?? [])
    for (const item of turn.items)
      for (const reply of item.questionReplies ?? []) {
        const previous = questionReplies.get(reply.questionItemId) ?? [];
        questionReplies.set(reply.questionItemId, [...previous, reply]);
      }
  const activeCompaction =
    latestTurn && isActive(latestTurn.status)
      ? latestTurn.items.findLast(
          (item) => item.type === 'contextCompaction' && item.status === 'inProgress',
        )
      : undefined;
  const locale = currentLocale();
  useLayoutEffect(() => {
    if (previousThread.current !== thread?.id) {
      previousThread.current = thread?.id;
      stickToBottom.current = true;
      setShowBottom(false);
      anchor.current = undefined;
      scrollingUp.current = false;
      userScrolled.current = false;
    }
    const box = containerRef.current;
    if (stickToBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
    else if (box && anchor.current) {
      const target = [...box.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
        (element) => element.dataset.turnId === anchor.current!.id,
      );
      if (target)
        box.scrollTop +=
          target.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          anchor.current.offset;
    }
    if (box) lastScrollTop.current = box.scrollTop;
  }, [thread, locale]);
  const updateScrollPosition = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    scrollingUp.current = userScrolled.current && box.scrollTop < lastScrollTop.current;
    lastScrollTop.current = box.scrollTop;
    const firstVisible = [...box.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (element) => element.getBoundingClientRect().bottom > box.getBoundingClientRect().top,
    );
    anchor.current = firstVisible
      ? {
          id: firstVisible.dataset.turnId!,
          offset: firstVisible.getBoundingClientRect().top - box.getBoundingClientRect().top,
        }
      : undefined;
    if (
      scrollingUp.current &&
      box.scrollTop < Math.max(600, box.clientHeight * 1.5) &&
      !history?.error
    )
      history?.onLoadOlder();
    stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    setShowBottom(!stickToBottom.current);
  }, [history]);
  useEffect(() => {
    const box = containerRef.current;
    if (
      box &&
      scrollingUp.current &&
      box.scrollTop < Math.max(600, box.clientHeight * 1.5) &&
      !history?.loading &&
      !history?.error
    )
      history?.onLoadOlder();
  }, [thread, history]);
  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const onToggle = (event: Event) => {
      // Expanding a long card need not scroll, but should stop following new output.
      if (
        event.target instanceof HTMLDetailsElement &&
        event.target.classList.contains('collapsible-activity')
      )
        updateScrollPosition();
    };
    box.addEventListener('toggle', onToggle, true);
    return () => box.removeEventListener('toggle', onToggle, true);
  }, [updateScrollPosition]);
  useEffect(() => {
    const box = containerRef.current;
    const end = endRef.current;
    const threadId = thread?.id;
    const turnId = latestTurn?.id;
    if (
      !readingEnabled ||
      !onReadCompleted ||
      !box ||
      !end ||
      !threadId ||
      !turnId ||
      latestTurn.status !== 'completed'
    )
      return;

    const reportRead = () => {
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        document.querySelector('dialog[open]') ||
        box.clientHeight === 0
      )
        return;
      const bounds = box.getBoundingClientRect();
      const ending = end.getBoundingClientRect();
      const visibleTop = Math.max(0, bounds.top + box.clientTop);
      const visibleBottom = Math.min(
        window.innerHeight,
        bounds.top + box.clientTop + box.clientHeight,
      );
      // The zero-height sentinel follows the last turn. Scrolling through older history
      // must not acknowledge a completion that remains below the visible conversation.
      if (visibleBottom <= visibleTop || ending.top < visibleTop || ending.bottom > visibleBottom)
        return;
      const previous = lastReadCompletion.current;
      if (previous?.threadId === threadId && previous.turnId === turnId) return;
      lastReadCompletion.current = { threadId, turnId };
      onReadCompleted(threadId, turnId);
    };

    const observer = new IntersectionObserver(reportRead, { root: box });
    observer.observe(end);
    box.addEventListener('scroll', reportRead);
    window.addEventListener('focus', reportRead);
    document.addEventListener('focusin', reportRead);
    document.addEventListener('close', reportRead, true);
    document.addEventListener('visibilitychange', reportRead);
    reportRead();
    return () => {
      observer.disconnect();
      box.removeEventListener('scroll', reportRead);
      window.removeEventListener('focus', reportRead);
      document.removeEventListener('focusin', reportRead);
      document.removeEventListener('close', reportRead, true);
      document.removeEventListener('visibilitychange', reportRead);
    };
  }, [thread?.id, latestTurn?.id, latestTurn?.status, readingEnabled, onReadCompleted]);
  return (
    <div className="conversation-area">
      {history?.cached && (
        <div className="history-cache-notice" role="status">
          <span>
            {history.syncError
              ? t('conversation:showing_local_cache_sync_failed_some_history_may')
              : t('conversation:showing_local_cache_checking_latest_messages_and_task')}
          </span>
          {history.syncError && (
            <Button variant="ghost" size="sm" onClick={history.onRetryOpen}>
              {t('conversation:resynchronize')}
            </Button>
          )}
        </div>
      )}
      {latestTurn?.reconnect && !isCapacityTurnError(latestTurn) && (
        <div className="codex-reconnect-pinned">
          <CodexReconnectNotice turn={latestTurn} offline={offline} />
        </div>
      )}
      {activeCompaction && (
        <div className="context-compaction-pinned">
          <ContextCompaction item={activeCompaction} offline={offline} />
        </div>
      )}
      <div className="conversation-viewport">
        <StickyPrompt
          thread={thread}
          onJump={() => {
            stickToBottom.current = false;
          }}
        />
        <div
          className="conversation-scroll"
          ref={containerRef}
          onScroll={updateScrollPosition}
          onWheel={() => {
            userScrolled.current = true;
          }}
          onTouchStart={() => {
            userScrolled.current = true;
          }}
          onPointerDown={() => {
            userScrolled.current = true;
          }}
          onKeyDown={(event) => {
            if (
              ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
            )
              userScrolled.current = true;
          }}
          tabIndex={0}
          aria-label={t('conversation:session_messages')}
        >
          <div className="conversation-content">
            {(thread?.history?.olderCursor || history?.error) && (
              <div
                className="history-pagination"
                role="status"
                aria-live="polite"
                aria-busy={history?.loading}
              >
                <span>
                  {history?.error ??
                    (history?.loading
                      ? t('conversation:loading_earlier_messages')
                      : t('conversation:scroll_up_to_load_earlier_messages'))}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={history?.loading}
                  onClick={() => history?.onLoadOlder()}
                >
                  {history?.error
                    ? t('conversation:retry_loading')
                    : t('conversation:load_earlier_messages')}
                </Button>
                {history?.error && history.cached && thread?.history?.olderCursor && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={history.loading || history.cacheExhausted}
                    onClick={history.onLoadCachedOlder}
                  >
                    {history.cacheExhausted
                      ? t('conversation:no_local_cache_here_yet')
                      : t('conversation:continue_reading_local_history')}
                  </Button>
                )}
              </div>
            )}
            {thread?.historyTruncated && (
              <p className="truncation">
                <Icon name="alert" size={14} />
                {t('conversation:some_older_history_is_omitted_from_this_live')}
              </p>
            )}
            {history?.opening && !thread?.turns.length ? (
              <div className="history-opening" role={history.openingError ? 'alert' : 'status'}>
                <p>{history.openingError ?? t('common:loading_session')}</p>
                {history.openingError ? (
                  <Button variant="secondary" onClick={history.onRetryOpen}>
                    {t('conversation:retry_reading')}
                  </Button>
                ) : (
                  <div className="history-skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            ) : !thread?.turns.length ? (
              <div
                className="empty-state"
                data-testid="workspace-start"
                data-thread-ready={Boolean(thread)}
              >
                <div className="empty-symbol">
                  <Icon name="code" size={36} />
                </div>
                <p className="eyebrow">{t('conversation:your_development_workspace')}</p>
                <h1>{t('conversation:start_with_an_idea')}</h1>
                <p>
                  {t('conversation:describe_your_task_or_paste_an_image_question')}
                  <br />
                  {projectName
                    ? t('conversation:start_in_project', { v0: projectName })
                    : t('conversation:start_without_project')}
                </p>
                {needsProject && (
                  <Button variant="ghost" onClick={onAddProject} disabled={!canAddProject}>
                    <Icon name="plus" size={16} />
                    {t('common:add_project')}
                  </Button>
                )}
                <div className="empty-features">
                  <span>
                    <Icon name="terminal" size={16} />
                    {t('conversation:live_execution')}
                  </span>
                  <span>
                    <Icon name="code" size={16} />
                    {t('conversation:changes_by_turn')}
                  </span>
                  <span>
                    <Icon name="check" size={16} />
                    {t('conversation:approve_and_follow_up_anytime')}
                  </span>
                </div>
              </div>
            ) : (
              thread.turns.map((turn, index) => (
                <section
                  className="turn"
                  key={turn.id}
                  data-turn-id={turn.id}
                  aria-label={t('conversation:turn', { v0: index + 1 })}
                >
                  <div className="turn-heading">
                    <span>{t('conversation:turn', { v0: index + 1 })}</span>
                    <Status status={turn.status} offline={offline} />
                  </div>
                  {turn.id !== latestTurn?.id &&
                    turn.reconnect?.status === 'failed' &&
                    !isCapacityTurnError(turn) && (
                      <CodexReconnectNotice turn={turn} offline={offline} />
                    )}
                  {groupConversationItems(turn.items).map((group) =>
                    group.kind === 'message' ? (
                      <Item
                        key={group.key}
                        item={group.item}
                        streaming={isActive(turn.status)}
                        questionControls={questionControls}
                        replies={[
                          ...(questionReplies.get(group.item.id) ?? []),
                          ...(group.item.questions ?? []).flatMap(
                            (_, index) =>
                              questionReplies.get(asyncQuestionId(group.item.id, index)) ?? [],
                          ),
                        ]}
                      />
                    ) : (
                      <ActivityGroup key={group.key} items={group.items}>
                        {group.items.map((item) => (
                          <Item key={item.id} item={item} streaming={isActive(turn.status)} />
                        ))}
                      </ActivityGroup>
                    ),
                  )}
                  {(turn.diff !== undefined || turn.items.some((item) => item.changes?.length)) && (
                    <Button
                      className="turn-diff"
                      variant="ghost"
                      onClick={() =>
                        openDiff({
                          id: turn.id,
                          scope: message('conversation:turn_changes', { v0: index + 1 }),
                          source: 'turn',
                        })
                      }
                    >
                      <Icon name="code" size={17} />
                      <span>
                        {t('conversation:changes_in_this_turn')}
                        <small>{t('conversation:view_file_and_line_changes')}</small>
                      </span>
                      <Icon name="chevron" size={16} />
                    </Button>
                  )}
                  <TurnErrorNotice turn={turn} offline={offline} />
                  <TurnCompletion turn={turn} />
                </section>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>
      </div>
      {showBottom && (
        <Button
          className="back-to-bottom"
          variant="secondary"
          size="sm"
          onClick={() => {
            stickToBottom.current = true;
            setShowBottom(false);
            endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          <Icon name="down" size={15} />
          {t('conversation:back_to_latest')}
        </Button>
      )}
    </div>
  );
}

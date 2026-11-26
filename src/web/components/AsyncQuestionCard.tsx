import { t } from '../i18n';
import type { QuestionSkips } from '../hooks/useQuestionSkips';
import { useId, useRef, useState } from 'react';
import type { AsyncQuestion, AsyncQuestionReply, ThreadView } from '../../shared/types';
import { questionAnswer } from '../../shared/pending-questions';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { usesMobileInput } from '../lib/mobile-input';
import { MarkdownContent } from './MarkdownContent';

export interface AsyncQuestionControls {
  disabled: boolean;
  tracking?: ThreadView['questionTracking'];
  skips?: QuestionSkips;
  onDismiss?: (questionIds: string[]) => void;
  onReply: (replies: AsyncQuestionReply[]) => Promise<boolean>;
}

export function AsyncQuestionCard({
  itemId,
  questions,
  replies = [],
  disabled,
  onReply,
  tracking,
  skips,
  onDismiss,
}: AsyncQuestionControls & {
  itemId: string;
  questions: AsyncQuestion[];
  replies?: AsyncQuestionReply[];
}) {
  const id = useId();
  const shortcutId = `${id}-shortcut`;
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const mobileInput = usesMobileInput(navigator);
  const shortcut = mac ? '⌘ + Enter' : 'Ctrl + Enter';
  const shortcutAria = mac ? 'Meta+Enter' : 'Control+Enter';
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(-Infinity);
  const [choices, setChoices] = useState<number[]>(() =>
    questions.map((q) => (q.options?.length ? 0 : -1)),
  );
  const [texts, setTexts] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const recorded = questions.map((q, index) =>
    questionAnswer(replies, asyncQuestionId(itemId, index), itemId, q.title),
  );
  const skipStatus = questions.map(
    (_, index) => skips?.get(asyncQuestionId(itemId, index))?.status,
  );
  const dismissed = questions.map(
    (_, index) =>
      tracking?.[asyncQuestionId(itemId, index)]?.status === 'dismissed' ||
      skipStatus[index] === 'skipped',
  );
  const settled = recorded.map(
    (answer, index) => answer !== undefined || dismissed[index] || skipStatus[index] === 'answered',
  );
  const skipPending = skipStatus.map(
    (status, index) => !settled[index] && (status === 'skipping' || status === 'unknown'),
  );
  const available = settled.flatMap((done, index) => (done || skipPending[index] ? [] : [index]));
  const pendingSubmission = questions.some(
    (_, index) =>
      !settled[index] &&
      ['submitting', 'unknown'].includes(tracking?.[asyncQuestionId(itemId, index)]?.status ?? ''),
  );
  const resolved = settled.every(Boolean);
  const dismiss = (indexes: number[]) => {
    if (disabled || sendingRef.current) return;
    onDismiss?.(indexes.map((index) => asyncQuestionId(itemId, index)));
  };
  const answers = questions.map(
    (q, index) =>
      recorded[index] ??
      (choices[index] === -1 ? texts[index]?.trim() : q.options?.[choices[index] ?? 0]) ??
      '',
  );
  const locked = disabled || sending || pendingSubmission || resolved;
  const answerLocked = locked || skipPending.some(Boolean);
  const incomplete = answers.some((answer, index) => !settled[index] && !answer);
  const showShortcut =
    !mobileInput && choices.some((choice, index) => choice === -1 && recorded[index] === undefined);
  return (
    <section
      className="async-question-card"
      aria-label={t('workspace:questions_from_codex')}
      data-attention-kind="question"
      data-attention-id={itemId}
      tabIndex={-1}
    >
      <div className="async-question-heading">
        <span>
          <Icon name="chat" size={16} />
          {t(
            available.length ? 'workspace:your_answer_is_needed' : 'workspace:questions_from_codex',
          )}
        </span>
        <small>
          {skipPending.some(Boolean) && !available.length
            ? null
            : resolved
              ? dismissed.some(Boolean)
                ? t('workspace:questions_handled')
                : t('workspace:answer_sent')
              : sending
                ? t('workspace:sending')
                : pendingSubmission
                  ? t('workspace:answer_receipt_pending')
                  : t('workspace:you_can_answer_later')}
        </small>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (answerLocked || sendingRef.current || incomplete) return;
          sendingRef.current = true;
          setSending(true);
          try {
            // Native history confirms the answer; an accepted submission alone may still be pending.
            await onReply(
              questions.flatMap((q, index) =>
                settled[index]
                  ? []
                  : [
                      {
                        questionItemId: asyncQuestionId(itemId, index),
                        question: q.title,
                        answer: answers[index]!,
                      },
                    ],
              ),
            );
          } finally {
            sendingRef.current = false;
            setSending(false);
          }
        }}
      >
        {questions.map((question, index) => (
          <fieldset
            key={index}
            disabled={locked || settled[index] || skipPending[index]}
            aria-labelledby={`${id}-question-${index}`}
            data-question-id={asyncQuestionId(itemId, index)}
          >
            <div className="async-question-item-heading">
              <div className="async-question-title" id={`${id}-question-${index}`} tabIndex={-1}>
                <MarkdownContent text={question.title} />
              </div>
              {!settled[index] && !skipPending[index] && onDismiss && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="async-question-dismiss"
                  disabled={locked}
                  title={t('workspace:end_tracking_hint')}
                  onClick={() => dismiss([index])}
                >
                  {t('workspace:end_question_tracking')}
                </Button>
              )}
            </div>
            {recorded[index] !== undefined ? (
              <div className="async-question-answer">
                <MarkdownContent text={recorded[index]} />
              </div>
            ) : dismissed[index] ? (
              <p className="async-question-answer">{t('workspace:question_tracking_ended')}</p>
            ) : skipStatus[index] === 'answered' ? (
              <p className="async-question-answer">{t('workspace:answer_sent')}</p>
            ) : skipPending[index] ? (
              <p className="async-question-answer" role="status">
                {t(
                  skipStatus[index] === 'unknown'
                    ? 'workspace:question_skip_unconfirmed'
                    : 'workspace:question_skips_in_progress',
                )}
              </p>
            ) : (
              <>
                {skipStatus[index] === 'failed' && (
                  <p className="inline-error" role="alert">
                    {t('workspace:question_skip_failed')}
                  </p>
                )}
                {question.options?.map((option, choice) => (
                  <div
                    className="question-option"
                    key={choice}
                    onClick={(event) => {
                      // Keep links, previews and code actions independent of radio selection.
                      if (
                        locked ||
                        (event.target instanceof Element &&
                          event.target.closest('a, button, input, textarea, select, summary'))
                      )
                        return;
                      setChoices((previous) =>
                        previous.map((value, i) => (i === index ? choice : value)),
                      );
                      event.currentTarget.querySelector('input')?.focus();
                    }}
                  >
                    <input
                      type="radio"
                      name={`${id}-${index}`}
                      aria-labelledby={`${id}-option-${index}-${choice}`}
                      checked={choices[index] === choice}
                      onChange={() =>
                        setChoices((previous) =>
                          previous.map((value, i) => (i === index ? choice : value)),
                        )
                      }
                    />
                    <div id={`${id}-option-${index}-${choice}`} className="async-option-content">
                      <MarkdownContent text={option} />
                    </div>
                  </div>
                ))}
                {Boolean(question.options?.length) && (
                  <label className="question-option">
                    <input
                      type="radio"
                      name={`${id}-${index}`}
                      checked={choices[index] === -1}
                      onChange={() =>
                        setChoices((previous) =>
                          previous.map((value, i) => (i === index ? -1 : value)),
                        )
                      }
                    />
                    <span>{t('workspace:free_text_answer')}</span>
                  </label>
                )}
                {choices[index] === -1 && (
                  <textarea
                    className="text-input"
                    aria-label={t('common:free_text_answer', { v0: question.title })}
                    placeholder={t('common:enter_your_answer')}
                    enterKeyHint="enter"
                    aria-describedby={mobileInput ? undefined : shortcutId}
                    aria-keyshortcuts={mobileInput ? undefined : shortcutAria}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false;
                      compositionEndedAtRef.current = performance.now();
                    }}
                    onBlur={() => {
                      composingRef.current = false;
                      compositionEndedAtRef.current = -Infinity;
                    }}
                    onKeyUp={(event) => {
                      if (event.key === 'Enter') compositionEndedAtRef.current = -Infinity;
                    }}
                    onKeyDown={(event) => {
                      if (
                        mobileInput ||
                        event.defaultPrevented ||
                        event.key !== 'Enter' ||
                        event.shiftKey ||
                        event.altKey ||
                        (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
                      )
                        return;
                      // Keep IME confirmation native, including Safari's early compositionend.
                      if (
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229 ||
                        composingRef.current
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.repeat || performance.now() - compositionEndedAtRef.current < 100)
                        return;
                      // Use this card's form so click and keyboard share every submit guard.
                      event.currentTarget.form?.requestSubmit();
                    }}
                    rows={2}
                    maxLength={10000}
                    value={texts[index] ?? ''}
                    onChange={(event) =>
                      setTexts((previous) => {
                        const next = [...previous];
                        next[index] = event.target.value;
                        return next;
                      })
                    }
                  />
                )}
              </>
            )}
          </fieldset>
        ))}
        {available.length > 0 && (
          <div className="async-question-footer">
            <span>{t('workspace:your_answer_will_be_sent_to_this_session')}</span>
            <div className="async-question-actions">
              {onDismiss && available.length > 1 && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  title={t('workspace:skip_all_questions_hint')}
                  onClick={() => dismiss(available)}
                >
                  {t('workspace:end_remaining_tracking')}
                </Button>
              )}
              <ControlHint
                id={shortcutId}
                content={
                  showShortcut ? t('workspace:answer_submit_shortcut', { shortcut }) : undefined
                }
                asChild
              >
                <Button type="submit" disabled={answerLocked || incomplete}>
                  {sending ? t('workspace:sending') : t('workspace:send_answer')}
                  {showShortcut && (
                    <kbd className="answer-submit-shortcut" aria-hidden="true">
                      {shortcut}
                    </kbd>
                  )}
                </Button>
              </ControlHint>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

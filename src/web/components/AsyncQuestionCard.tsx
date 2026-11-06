import { t } from '../i18n';
import { useId, useRef, useState } from 'react';
import type { AsyncQuestion, AsyncQuestionReply, ThreadView } from '../../shared/types';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { usesMobileInput } from '../lib/mobile-input';
import { MarkdownContent } from './MarkdownContent';

export interface AsyncQuestionControls {
  disabled: boolean;
  tracking?: ThreadView['questionTracking'];
  onDismiss?: (questionIds: string[]) => Promise<boolean>;
  onReply: (replies: AsyncQuestionReply[]) => Promise<boolean>;
}

export function AsyncQuestionCard({
  itemId,
  questions,
  replies = [],
  disabled,
  onReply,
  tracking,
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
  const recorded = questions.map(
    (q, index) =>
      replies.find((reply) => reply.questionItemId === asyncQuestionId(itemId, index))?.answer ??
      replies.find((reply) => reply.questionItemId === itemId && reply.question === q.title)
        ?.answer,
  );
  const dismissed = questions.map(
    (_, index) => tracking?.[asyncQuestionId(itemId, index)]?.status === 'dismissed',
  );
  const settled = recorded.map((answer, index) => answer !== undefined || dismissed[index]);
  const pendingSubmission = questions.some(
    (_, index) =>
      !settled[index] &&
      ['submitting', 'unknown'].includes(tracking?.[asyncQuestionId(itemId, index)]?.status ?? ''),
  );
  const resolved = settled.every(Boolean);
  const dismiss = async (indexes: number[]) => {
    if (disabled || sendingRef.current || !onDismiss) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onDismiss(indexes.map((index) => asyncQuestionId(itemId, index)));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const answers = questions.map(
    (q, index) =>
      recorded[index] ??
      (choices[index] === -1 ? texts[index]?.trim() : q.options?.[choices[index] ?? 0]) ??
      '',
  );
  const locked = disabled || sending || pendingSubmission || resolved;
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
          {t(resolved ? 'workspace:questions_from_codex' : 'workspace:your_answer_is_needed')}
        </span>
        <small>
          {resolved
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
          if (locked || sendingRef.current || incomplete) return;
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
            disabled={locked || settled[index]}
            aria-labelledby={`${id}-question-${index}`}
          >
            <div className="async-question-item-heading">
              <div className="async-question-title" id={`${id}-question-${index}`}>
                <MarkdownContent text={question.title} />
              </div>
              {!settled[index] && onDismiss && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="async-question-dismiss"
                  disabled={locked}
                  title={t('workspace:end_tracking_hint')}
                  onClick={() => void dismiss([index])}
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
            ) : (
              <>
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
        {!resolved && (
          <div className="async-question-footer">
            <span>{t('workspace:your_answer_will_be_sent_to_this_session')}</span>
            <div className="async-question-actions">
              {onDismiss && settled.filter((done) => !done).length > 1 && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  title={t('workspace:end_tracking_hint')}
                  onClick={() =>
                    void dismiss(settled.flatMap((done, index) => (done ? [] : [index])))
                  }
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
                <Button type="submit" disabled={locked || incomplete}>
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

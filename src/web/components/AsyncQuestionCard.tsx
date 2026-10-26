import { t } from '../i18n';
import { useId, useRef, useState } from 'react';
import type { AsyncQuestion, AsyncQuestionReply } from '../../shared/types';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { usesMobileInput } from '../lib/mobile-input';

export interface AsyncQuestionControls {
  disabled: boolean;
  onReply: (replies: AsyncQuestionReply[]) => Promise<boolean>;
}

export function AsyncQuestionCard({
  itemId,
  questions,
  replies = [],
  disabled,
  onReply,
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
  const [sent, setSent] = useState<string[]>();
  const recorded = questions.map(
    (q, index) =>
      replies.find((reply) => reply.questionItemId === asyncQuestionId(itemId, index))?.answer ??
      replies.find((reply) => reply.questionItemId === itemId && reply.question === q.title)
        ?.answer ??
      sent?.[index],
  );
  const resolved = recorded.every((answer) => answer !== undefined);
  const answers = questions.map(
    (q, index) =>
      recorded[index] ??
      (choices[index] === -1 ? texts[index] : q.options?.[choices[index] ?? 0])?.trim() ??
      '',
  );
  const locked = disabled || sending || Boolean(resolved);
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
          {t('workspace:your_answer_is_needed')}
        </span>
        <small>
          {resolved
            ? t('workspace:answer_sent')
            : sending
              ? t('workspace:sending')
              : t('workspace:you_can_answer_later')}
        </small>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked || sendingRef.current || answers.some((answer) => !answer)) return;
          sendingRef.current = true;
          setSending(true);
          try {
            if (
              await onReply(
                questions.flatMap((q, index) =>
                  recorded[index] !== undefined
                    ? []
                    : [
                        {
                          questionItemId: asyncQuestionId(itemId, index),
                          question: q.title,
                          answer: answers[index]!,
                        },
                      ],
                ),
              )
            )
              setSent(answers);
          } finally {
            sendingRef.current = false;
            setSending(false);
          }
        }}
      >
        {questions.map((question, index) => (
          <fieldset key={index} disabled={locked || recorded[index] !== undefined}>
            <legend>{question.title}</legend>
            {recorded[index] !== undefined ? (
              <p className="async-question-answer">{recorded[index]}</p>
            ) : (
              <>
                {question.options?.map((option, choice) => (
                  <label className="question-option" key={choice}>
                    <input
                      type="radio"
                      name={`${id}-${index}`}
                      checked={choices[index] === choice}
                      onChange={() =>
                        setChoices((previous) =>
                          previous.map((value, i) => (i === index ? choice : value)),
                        )
                      }
                    />
                    <span>{option}</span>
                  </label>
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
            <ControlHint
              id={shortcutId}
              content={
                showShortcut ? t('workspace:answer_submit_shortcut', { shortcut }) : undefined
              }
              asChild
            >
              <Button type="submit" disabled={locked || answers.some((answer) => !answer)}>
                {sending ? t('workspace:sending') : t('workspace:send_answer')}
                {showShortcut && (
                  <kbd className="answer-submit-shortcut" aria-hidden="true">
                    {shortcut}
                  </kbd>
                )}
              </Button>
            </ControlHint>
          </div>
        )}
      </form>
    </section>
  );
}

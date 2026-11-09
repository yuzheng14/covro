import { actionTitle, actionOptionLabel } from '../lib/action-labels';
import { t } from '../i18n';
import { useState } from 'react';
import type { ActionResolution, PendingAction } from '../../shared/types';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { PermissionDetails } from './PermissionDetails';
import { ElicitationForm } from './ElicitationForm';
import { actionStatusLabel } from '../lib/action-status';

export function ActionCard({
  action,
  disabled,
  onResolve,
}: {
  action: PendingAction;
  disabled: boolean;
  onResolve: (resolution: ActionResolution) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const pending = action.status === 'pending';
  const questions = action.questions ?? [];
  const answerFor = (id: string) =>
    answers[id] === '__other__' ? (other[id]?.trim() ?? '') : (answers[id]?.trim() ?? '');
  const canSubmit =
    questions.length > 0 &&
    questions.every((question) => skipped.includes(question.id) || answerFor(question.id));
  // requestUserInput carries answers, not approval decisions. Use the input structure,
  // never words such as “允许” in the question, to describe the confirmation.
  const choosing =
    questions.length > 0 &&
    questions.every(
      (question) => question.options.length > 0 && answers[question.id] !== '__other__',
    );
  return (
    <section
      className={`action-card${action.kind === 'unsupported' ? ' action-card-unsupported' : ''}`}
      aria-label={actionTitle(action)}
      data-attention-kind="action"
      data-attention-id={action.actionId}
      tabIndex={-1}
    >
      <div className="action-heading">
        <span className="action-icon">
          <Icon name={action.kind === 'questions' ? 'chat' : 'alert'} size={17} />
        </span>
        <h3>{actionTitle(action)}</h3>
        <span className="action-state">
          {action.kind === 'unsupported' && action.status === 'expired'
            ? t('approvals:request_could_not_be_handled')
            : actionStatusLabel(action.status)}
        </span>
      </div>
      {action.reason && <p>{action.reason}</p>}
      {action.cwd && (
        <p className="mono subtle action-cwd">
          <span>{t('approvals:working_directory')}</span>
          {action.cwd}
        </p>
      )}
      {action.command && (
        <pre className="command">
          <code>{action.command}</code>
        </pre>
      )}
      {action.kind === 'permissions' && action.permissionRequest && (
        <PermissionDetails request={action.permissionRequest} />
      )}
      {action.details !== undefined && (
        <details
          className="raw-details"
          open={action.kind === 'network' || action.kind === 'file' || undefined}
        >
          <summary>
            {action.kind === 'network'
              ? t('approvals:network_destination')
              : action.kind === 'file'
                ? t('approvals:change_details')
                : action.kind === 'permissions' || action.kind === 'elicitation'
                  ? t('common:technical_details')
                  : t('approvals:request_details')}
          </summary>
          <pre>{JSON.stringify(action.details, null, 2)}</pre>
        </details>
      )}
      {action.kind === 'elicitation' && action.elicitation ? (
        <ElicitationForm
          request={action.elicitation}
          actionId={action.actionId}
          status={action.status}
          disabled={disabled || !pending}
          onResolve={onResolve}
        />
      ) : action.kind === 'questions' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && pending && canSubmit)
              onResolve({
                answers: Object.fromEntries(
                  questions
                    .filter((question) => !skipped.includes(question.id))
                    .map((question) => [question.id, [answerFor(question.id)]]),
                ),
                ...(skipped.length ? { skippedQuestionIds: skipped } : {}),
              });
          }}
        >
          {questions.map((question) => (
            <fieldset key={question.id} disabled={disabled || !pending}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {!pending ? (
                <p className="async-question-answer">
                  {action.questionAnswers?.[question.id]?.length === 0
                    ? t('approvals:question_skipped')
                    : (action.questionAnswers?.[question.id]?.join('\n') ??
                      actionStatusLabel(action.status))}
                </p>
              ) : skipped.includes(question.id) ? (
                <p>{t('approvals:question_will_be_skipped')}</p>
              ) : (
                <>
                  {question.options.map((option, index) => (
                    <label key={option.label} className="question-option">
                      <input
                        type="radio"
                        name={`${action.actionId}-${question.id}`}
                        value={option.label}
                        checked={answers[question.id] === option.label}
                        onChange={() =>
                          setAnswers((previous) => ({ ...previous, [question.id]: option.label }))
                        }
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span className="option-number">{index + 1}</span>
                    </label>
                  ))}
                  {question.options.length > 0 && question.isOther && (
                    <label className="question-option">
                      <input
                        type="radio"
                        name={`${action.actionId}-${question.id}`}
                        checked={answers[question.id] === '__other__'}
                        onChange={() =>
                          setAnswers((previous) => ({ ...previous, [question.id]: '__other__' }))
                        }
                      />
                      <span>{t('approvals:another_answer')}</span>
                    </label>
                  )}
                </>
              )}
              {pending && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSkipped((previous) =>
                      previous.includes(question.id)
                        ? previous.filter((id) => id !== question.id)
                        : [...previous, question.id],
                    )
                  }
                >
                  {skipped.includes(question.id)
                    ? t('approvals:answer_question')
                    : t('approvals:skip_question')}
                </Button>
              )}
              {pending &&
                !skipped.includes(question.id) &&
                (question.options.length === 0 || answers[question.id] === '__other__') && (
                  <input
                    className="text-input"
                    type={question.isSecret ? 'password' : 'text'}
                    aria-label={t('common:free_text_answer', { v0: question.header })}
                    value={
                      question.options.length === 0
                        ? (answers[question.id] ?? '')
                        : (other[question.id] ?? '')
                    }
                    maxLength={10000}
                    onChange={(event) =>
                      question.options.length === 0
                        ? setAnswers((previous) => ({
                            ...previous,
                            [question.id]: event.target.value,
                          }))
                        : setOther((previous) => ({
                            ...previous,
                            [question.id]: event.target.value,
                          }))
                    }
                    placeholder={t('common:enter_your_answer')}
                    autoComplete="off"
                  />
                )}
            </fieldset>
          ))}
          {pending && (
            <div className="action-options">
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  onResolve({
                    answers: {},
                    skippedQuestionIds: questions.map((question) => question.id),
                  })
                }
              >
                {t('approvals:skip_all_questions')}
              </Button>
              <Button type="submit" disabled={disabled || !canSubmit}>
                {skipped.length
                  ? t('approvals:submit_with_skipped')
                  : choosing
                    ? t('common:confirm_selection')
                    : t('common:submit_answer')}
              </Button>
            </div>
          )}
        </form>
      ) : (
        <div className="action-options">
          {action.options.map((option) => (
            <Button
              key={option.id}
              variant={/decline|cancel|reject|deny/i.test(option.id) ? 'secondary' : 'default'}
              disabled={disabled || !pending}
              onClick={() => onResolve({ decision: option.id })}
            >
              {actionOptionLabel(action, option)}
            </Button>
          ))}
        </div>
      )}
      {action.kind === 'unsupported' && (
        <p className="inline-error">
          {t('approvals:this_interaction_is_unsupported_no_approval_was_sent')}
        </p>
      )}
    </section>
  );
}

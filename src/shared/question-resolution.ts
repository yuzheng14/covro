import { AppError } from './errors.js';
import type { ActionResolution, Question } from './types.js';

/** Native CLI skips use [], explicitly selected by the user; never an empty string. */
export function questionAnswers(questions: Question[], resolution: ActionResolution) {
  if (!('answers' in resolution)) throw new AppError('VALIDATION_ERROR', '请按问题提交答案');
  const ids = new Set(questions.map((question) => question.id));
  const skipped = new Set(resolution.skippedQuestionIds ?? []);
  if ([...Object.keys(resolution.answers), ...skipped].some((id) => !ids.has(id)))
    throw new AppError('VALIDATION_ERROR', '回答包含未知问题');
  const result: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const values = resolution.answers[question.id];
    if (skipped.has(question.id)) {
      if (values?.length) throw new AppError('VALIDATION_ERROR', '跳过的问题不能同时提交回答');
      result[question.id] = { answers: [] };
      continue;
    }
    if (
      !values?.length ||
      values.some(
        (value) =>
          !value.trim() ||
          (!question.isOther &&
            question.options.length > 0 &&
            !question.options.some((option) => option.label === value)),
      )
    )
      throw new AppError('VALIDATION_ERROR', `问题 ${question.header} 的回答不符合选项要求`);
    result[question.id] = { answers: values };
  }
  return result;
}

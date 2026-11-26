import { z } from 'zod';
import {
  ADAPTIVE_LOOP_MAX_SECONDS,
  ADAPTIVE_LOOP_MIN_SECONDS,
  type SessionLoopDecision,
} from '../shared/session-loop.js';
import type { TurnView } from '../shared/types.js';

export const adaptiveLoopOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'reason', 'action', 'delaySeconds'],
  properties: {
    summary: { type: 'string', description: 'The result to report to the user.' },
    reason: {
      type: 'string',
      description: 'A short explanation of the next delay or why to stop.',
    },
    action: { type: 'string', enum: ['continue', 'stop'] },
    delaySeconds: {
      type: ['integer', 'null'],
      description: `For continue, whole seconds from ${ADAPTIVE_LOOP_MIN_SECONDS} to ${ADAPTIVE_LOOP_MAX_SECONDS}. For stop, null.`,
    },
  },
};

const report = {
  summary: z.string().trim().min(1).max(32_000),
  reason: z.string().trim().min(1).max(500),
};
const decisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...report,
    action: z.literal('continue'),
    delaySeconds: z.number().int().min(ADAPTIVE_LOOP_MIN_SECONDS).max(ADAPTIVE_LOOP_MAX_SECONDS),
  }),
  z.strictObject({ ...report, action: z.literal('stop'), delaySeconds: z.null() }),
]);

export function adaptiveLoopPrompt(prompt: string): string {
  return [
    'Covro is running one check of an adaptive loop. Perform the task below once.',
    'Report the result in summary and explain in reason when to check again or why to stop. Use the language of the task.',
    `Choose continue with a delaySeconds between ${ADAPTIVE_LOOP_MIN_SECONDS} and ${ADAPTIVE_LOOP_MAX_SECONDS} if another check is needed. Choose stop with delaySeconds null if the task is finished.`,
    'Covro will schedule the next run from your response. Finish this turn without waiting for the next check.',
    '',
    prompt,
  ].join('\n');
}

export function adaptiveLoopAnswer(turn: TurnView) {
  return turn.items.findLast(
    (item) => item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer'),
  );
}

export function readAdaptiveLoopDecision(turn: TurnView): SessionLoopDecision | undefined {
  const answer = adaptiveLoopAnswer(turn);
  if (!answer?.text || answer.moderation?.moderated) return;
  try {
    const result = decisionSchema.safeParse(JSON.parse(answer.text));
    if (result.success) return result.data;
  } catch {
    // A malformed final answer cannot authorize a future run.
  }
}

import type { OperationInput, Settings } from './types.js';

export const LOOP_MIN_INTERVAL = 60_000;
export const LOOP_MAX_INTERVAL = 24 * 60 * LOOP_MIN_INTERVAL;
export const LOOP_MAX_PROMPT = 16_000;

export const ADAPTIVE_LOOP_MIN_SECONDS = LOOP_MIN_INTERVAL / 1_000;
export const ADAPTIVE_LOOP_MAX_SECONDS = LOOP_MAX_INTERVAL / 1_000;

export type SessionLoopSchedule =
  { mode?: 'fixed'; intervalMs: number } | { mode: 'adaptive'; intervalMs?: undefined };

export type CreateSessionLoop = OperationInput &
  SessionLoopSchedule & {
    prompt: string;
    settings?: Settings;
  };

export type SessionLoopDecision = {
  summary: string;
  reason: string;
} & ({ action: 'continue'; delaySeconds: number } | { action: 'stop'; delaySeconds: null });

export type SessionLoopAction = 'pause' | 'resume' | 'cancel';
export type SessionLoopControl =
  | { action: SessionLoopAction; version: number }
  | { action: 'set_interval'; version: number; intervalMs: number };
export type SessionLoopStatus = 'active' | 'paused' | 'cancelled' | 'completed';
export type SessionLoopReason =
  'archived' | 'unavailable' | 'uncertain' | 'deleted' | 'invalid_decision' | 'run_failed';
export type SessionLoopResult =
  'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'reconciled';

export interface SessionLoop {
  id: string;
  threadId: string;
  prompt: string;
  mode: 'fixed' | 'adaptive';
  intervalMs: number | null;
  status: SessionLoopStatus;
  reason: SessionLoopReason | null;
  version: number;
  runs: number;
  nextRunAt: number | null;
  lastDecision: SessionLoopDecision | null;
  lastStartedAt: number | null;
  lastResult: SessionLoopResult | null;
  lastTurnId: string | null;
}

export interface SessionLoopTask extends SessionLoop {
  projectId: string | null;
  projectName: string | null;
  threadTitle: string;
  archived: boolean;
  waiting: boolean;
}

export function parseSessionLoop(text: string): { intervalMs: number; prompt: string } | undefined {
  const match = /^(\d+)([mhd])\s+([\s\S]+)$/i.exec(text.trim());
  if (!match) return;
  const prompt = match[3]!.trim();
  const unit = match[2]!.toLowerCase();
  const intervalMs =
    Number(match[1]) * LOOP_MIN_INTERVAL * (unit === 'd' ? 1440 : unit === 'h' ? 60 : 1);
  if (
    intervalMs >= LOOP_MIN_INTERVAL &&
    intervalMs <= LOOP_MAX_INTERVAL &&
    prompt.length > 0 &&
    prompt.length <= LOOP_MAX_PROMPT
  )
    return { intervalMs, prompt };
}

export function parseAdaptiveSessionLoop(
  text: string,
): (SessionLoopSchedule & { prompt: string }) | undefined {
  const prompt = text.trim();
  if (prompt && prompt.length <= LOOP_MAX_PROMPT) return { mode: 'adaptive', prompt };
}

export function parseSessionLoopCommand(
  text: string,
): (SessionLoopSchedule & { prompt: string }) | undefined {
  const prompt = text.trim();
  // Reserve duration-like tokens so a typo cannot silently create a different schedule.
  if (/^[+-]?\d+(?:\.\d+)?[a-z]+(?:\s|$)/i.test(prompt)) return parseSessionLoop(prompt);
  return parseAdaptiveSessionLoop(prompt);
}

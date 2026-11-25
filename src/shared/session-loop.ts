import type { OperationInput, Settings } from './types.js';

export const LOOP_MIN_INTERVAL = 60_000;
export const LOOP_MAX_INTERVAL = 24 * 60 * LOOP_MIN_INTERVAL;
export const LOOP_DEFAULT_HOURS = 168;
export const LOOP_DEFAULT_RUNS = 100;
export const LOOP_MAX_HOURS = 720;
export const LOOP_MAX_RUNS = 1000;
export const LOOP_MAX_PROMPT = 16_000;

export interface CreateSessionLoop extends OperationInput {
  prompt: string;
  intervalMs: number;
  lifetimeHours?: number;
  maxRuns?: number;
  settings?: Settings;
}

export type SessionLoopAction = 'pause' | 'resume' | 'cancel';
export type SessionLoopStatus = 'active' | 'paused' | 'cancelled' | 'finished';
export type SessionLoopReason = 'archived' | 'unavailable' | 'uncertain' | 'deleted' | 'limit';
export type SessionLoopResult =
  'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'reconciled';

export interface SessionLoop {
  id: string;
  threadId: string;
  prompt: string;
  intervalMs: number;
  status: SessionLoopStatus;
  reason: SessionLoopReason | null;
  version: number;
  expiresAt: number;
  maxRuns: number;
  runs: number;
  nextRunAt: number;
  lastStartedAt: number | null;
  lastResult: SessionLoopResult | null;
  lastTurnId: string | null;
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
    prompt.length <= LOOP_MAX_PROMPT
  )
    return { intervalMs, prompt };
}

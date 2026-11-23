import type { RunStatus } from './types.js';

export const isActive = (status: RunStatus): boolean =>
  status === 'running' || status === 'waitingApproval' || status === 'waitingInput';

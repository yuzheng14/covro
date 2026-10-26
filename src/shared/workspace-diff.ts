import type { FileChange } from './types.js';

export interface WorkspaceDiff {
  cwd: string;
  readAt: number;
  staged: string;
  unstaged: string;
  untracked: FileChange[];
  truncated: boolean;
}

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../shared/errors.js';

/** A normal agent task, following the native CLI /init contract. */
export const PROJECT_INIT_PROMPT = `Create AGENTS.md in the current working directory as a concise contributor guide for this repository.
First check whether any AGENTS.md entry already exists. If it does, stop without modifying or replacing it.
Inspect the repository before writing. Describe its layout, actual build/test/development commands, coding conventions, testing expectations, and commit/pull-request practices. Adapt the content to the project, use concrete examples, and do not invent commands or policies. Aim for 200–400 words with clear Markdown headings. Respect the current permissions and approval policy. Report what was created, or why initialization could not be completed.`;

export async function assertProjectInstructionsMissing(cwd: string): Promise<void> {
  try {
    await lstat(join(cwd, 'AGENTS.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AppError(
      'AGENTS_CHECK_FAILED',
      'Cannot verify whether AGENTS.md already exists',
      409,
    );
  }
  throw new AppError(
    'AGENTS_EXISTS',
    'AGENTS.md already exists; the existing entry was preserved',
    409,
  );
}

import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import { fileToken, nativeFilePath, type FileReference } from '../shared/file-references.js';
import { containsPath } from './projects.js';

export interface ReferenceScope {
  cwd: string;
  excluded: string[];
}
const outside = () => new AppError('FILE_REFERENCE_OUTSIDE', 'File is outside this workspace', 403);

/** Check both spellings and the opened inode. File bytes stay on the Codex server. */
export async function validateReferencePath(path: string, scope: ReferenceScope) {
  if (
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^[a-z][a-z\d+.-]*:/iu.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.' || !part)
  )
    throw outside();
  const candidate = resolve(scope.cwd, ...path.split('/'));
  const allowed = (value: string) =>
    containsPath(scope.cwd, value) && !scope.excluded.some((root) => containsPath(root, value));
  if (!allowed(candidate)) throw outside();
  try {
    // Reject symlinks, including internal aliases: they must not change the selected identity.
    const canonical = await realpath(candidate);
    if (!allowed(canonical) || canonical !== candidate) throw outside();
    const file = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw new AppError('FILE_REFERENCE_NOT_FILE', 'Select a regular file', 400);
      const current = await realpath(candidate);
      if (!allowed(current) || current !== candidate) throw outside();
      const after = await stat(current);
      if (before.ino !== after.ino || before.dev !== after.dev)
        throw new AppError('FILE_REFERENCE_CHANGED', 'File changed; select it again', 409);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new AppError('FILE_REFERENCE_NOT_FOUND', 'File was moved or deleted', 404);
    if (code === 'ELOOP') throw outside();
    throw new AppError('FILE_REFERENCE_UNREADABLE', 'File cannot be read', 403);
  }
  return candidate;
}

export async function referenceMessage(
  text: string,
  references: FileReference[],
  scope: ReferenceScope,
) {
  let end = 0;
  const sorted = [...references].sort((a, b) => a.start - b.start);
  for (const reference of sorted) {
    if (
      reference.cwd !== scope.cwd ||
      reference.start < end ||
      reference.end > text.length ||
      text.slice(reference.start, reference.end) !== fileToken(reference.path)
    )
      throw new AppError(
        'FILE_REFERENCE_CHANGED',
        'File selection belongs to an older draft or workspace',
        409,
      );
    await validateReferencePath(reference.path, scope);
    end = reference.end;
  }
  for (const reference of sorted.reverse())
    text =
      text.slice(0, reference.start) + nativeFilePath(reference.path) + text.slice(reference.end);
  return text;
}

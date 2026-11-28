import { constants, realpathSync, statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import { containsPath } from './projects.js';

export interface FileRoot {
  canonicalRoot: string;
  aliases: string[];
}

export interface FileScope {
  cwd: string;
  roots: readonly FileRoot[];
  excludedRoots?: readonly string[];
}

/** Capture server-owned roots once; clients cannot nominate a temporary directory. */
export function temporaryFileRoots(): FileRoot[] {
  const roots = new Map<string, FileRoot>();
  for (const directory of [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]) {
    if (!isAbsolute(directory)) continue;
    const alias = resolve(directory);
    if (alias === parse(alias).root) continue;
    try {
      const canonicalRoot = realpathSync(alias);
      if (canonicalRoot === parse(canonicalRoot).root || !statSync(canonicalRoot).isDirectory())
        continue;
      const root = roots.get(canonicalRoot) ?? { canonicalRoot, aliases: [] };
      if (!root.aliases.includes(alias)) root.aliases.push(alias);
      roots.set(canonicalRoot, root);
    } catch {
      // Unavailable temp locations do not prevent previews in the remaining roots.
    }
  }
  return [...roots.values()];
}

interface FilePolicy {
  code: 'IMAGE' | 'MARKDOWN' | 'JSON' | 'TEXT' | 'VISUALIZATION';
  label: string;
  maxBytes: number;
  sizeError: string;
  validatePath: (path: string) => void;
}

function outsideProject(policy: FilePolicy): AppError {
  return new AppError(
    `${policy.code}_OUTSIDE_PROJECT`,
    `只能预览当前会话工作区或允许的服务器临时目录内的${policy.label}`,
    403,
  );
}

function changedFile(policy: FilePolicy): AppError {
  return new AppError(`${policy.code}_CHANGED`, `${policy.label}文件已变化，请重新打开预览`, 409);
}

/** Shared project/temp authorization and bounded, verified file reads for previews. */
export async function readLocalFile(
  path: string | undefined,
  scope: FileScope,
  policy: FilePolicy,
) {
  const windowsDrivePath = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(path ?? '');
  if (
    !path ||
    path.length > 4096 ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (!windowsDrivePath && /^[a-z][a-z\d+.-]*:/i.test(path)) ||
    path.startsWith('//') ||
    path.startsWith('\\\\')
  )
    throw new AppError(`INVALID_${policy.code}_PATH`, `${policy.label}路径无效`, 400);

  const candidate = resolve(scope.cwd, path);
  // Both spellings matter on systems where /tmp or the registered directory is an alias.
  if (
    !scope.roots.some(
      (root) =>
        containsPath(root.canonicalRoot, candidate) ||
        root.aliases.some((alias) => containsPath(alias, candidate)),
    )
  )
    throw outsideProject(policy);
  const isAllowed = (path: string) =>
    !scope.excludedRoots?.some((root) => containsPath(root, path)) &&
    scope.roots.some((root) => containsPath(root.canonicalRoot, path));
  policy.validatePath(candidate);

  try {
    const canonical = await realpath(candidate);
    if (!isAllowed(canonical)) throw outsideProject(policy);
    // NOFOLLOW rejects a last-component symlink swapped in after realpath. NONBLOCK
    // ensures opening a substituted FIFO cannot leave the request waiting forever.
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw new AppError(`${policy.code}_NOT_FILE`, `${policy.label}路径不是普通文件`, 415);
      if (before.size > policy.maxBytes)
        throw new AppError(`${policy.code}_TOO_LARGE`, policy.sizeError, 413);

      // Recheck the path and opened inode to detect ordinary concurrent replacements.
      // Node's portable file API cannot make parent-directory traversal race-free.
      const verifyPath = async () => {
        const current = await realpath(candidate);
        if (!isAllowed(current)) throw outsideProject(policy);
        if (current !== canonical) throw changedFile(policy);
        const currentStat = await stat(current);
        if (currentStat.dev !== before.dev || currentStat.ino !== before.ino)
          throw changedFile(policy);
      };
      await verifyPath();
      // One extra byte detects growth without letting readFile allocate unbounded data.
      const data = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await file.read(data, length, data.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > policy.maxBytes)
        throw new AppError(`${policy.code}_TOO_LARGE`, policy.sizeError, 413);
      const after = await file.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw changedFile(policy);
      await verifyPath();
      const bytes = data.subarray(0, length);
      return { bytes, path: canonical };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new AppError(`${policy.code}_NOT_FOUND`, `${policy.label}文件不存在或已被删除`, 404);
    if (code === 'ELOOP') throw outsideProject(policy);
    throw new AppError(`${policy.code}_UNREADABLE`, `${policy.label}文件不可读取`, 403);
  }
}

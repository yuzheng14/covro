import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, relative, resolve, sep } from 'node:path';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import type { WorkspaceDiff } from '../shared/workspace-diff.js';
import { containsPath } from './projects.js';
import { readLocalFile } from './local-files.js';

const exec = promisify(execFile);
const PATCH_BYTES = 512 * 1024;
const FILE_BYTES = 128 * 1024;

async function git(cwd: string, args: string[], maxBuffer = PATCH_BYTES) {
  try {
    const { stdout } = await exec(
      'git',
      ['--no-pager', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
    );
    return { text: stdout, truncated: false };
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: string };
    if (args[0] === 'config' && failure.code === 1) return { text: '', truncated: false };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { text: (failure.stdout ?? '').slice(0, maxBuffer), truncated: true };
    throw new AppError(
      failure.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_DIFF_FAILED',
      'Could not read Git changes in this workspace',
      409,
    );
  }
}

/** Read-only Git snapshots. No pager, external diff, configured filters or model requests. */
export async function readWorkspaceDiff(
  cwd: string,
  excludedRoots: readonly string[] = [],
): Promise<WorkspaceDiff> {
  try {
    if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'], 4096)).text.trim() !== 'true')
      throw new Error('Not a working tree');
  } catch (error) {
    if (error instanceof AppError && error.code === 'GIT_UNAVAILABLE') throw error;
    throw new AppError(
      'GIT_NOT_REPOSITORY',
      'The current workspace is not a Git working tree',
      409,
    );
  }
  const pathspec = [
    '--',
    '.',
    ...excludedRoots
      .filter((root) => containsPath(cwd, root))
      .map((root) => `:(exclude,literal)${relative(cwd, root).split(sep).join('/')}`),
  ];
  // Git diff can invoke clean/process filters even with --no-textconv. Discover
  // names only (never commands/credentials) and override every configured filter.
  const filters = await git(
    cwd,
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter[.].*[.](clean|process|smudge|required)$',
    ],
    128 * 1024,
  );
  if (filters.truncated)
    throw new AppError('GIT_DIFF_FAILED', 'Git filter configuration exceeds the read limit', 409);
  const filterOverrides = filters.text
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`]);
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--relative'];
  const staged = await git(cwd, [...filterOverrides, 'diff', '--cached', ...flags, ...pathspec]);
  const unstaged = await git(cwd, [...filterOverrides, 'diff', ...flags, ...pathspec]);
  const names = await git(
    cwd,
    ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec],
    128 * 1024,
  );
  // Only consume complete NUL-delimited names if the Git output was bounded.
  const paths = names.text
    .slice(0, names.text.lastIndexOf('\0') + 1)
    .split('\0')
    .filter(Boolean);
  let truncated = staged.truncated || unstaged.truncated || names.truncated || paths.length > 80;
  const untracked: WorkspaceDiff['untracked'] = [];
  let remaining = PATCH_BYTES;
  for (const path of paths.slice(0, 80)) {
    const header = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`;
    let diff = `${header}new file mode 100644\n`;
    try {
      if (!containsPath(cwd, resolve(cwd, path))) throw new Error('Outside workspace');
      const candidate = resolve(cwd, path);
      const info = await lstat(candidate);
      diff = `${header}new file mode ${info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'}\n`;
      let text: string | undefined;
      if (info.isSymbolicLink()) {
        const parent = await realpath(dirname(candidate));
        if (!containsPath(cwd, parent) || excludedRoots.some((root) => containsPath(root, parent)))
          throw new Error('Outside workspace');
        text = await readlink(candidate);
      } else {
        const { bytes } = await readLocalFile(
          path,
          { cwd, roots: [{ canonicalRoot: cwd, aliases: [cwd] }], excludedRoots },
          {
            code: 'TEXT',
            label: '文件',
            maxBytes: Math.min(FILE_BYTES, remaining),
            sizeError: 'File exceeds workspace diff limits',
            validatePath: () => {},
          },
        );
        try {
          if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          /* Binary data is represented by metadata only. */
        }
      }
      if (text === undefined)
        diff += `Binary files /dev/null and ${JSON.stringify(`b/${path}`)} differ\n`;
      else if (text) {
        const lines = text.split('\n');
        const newline = lines.at(-1) === '';
        if (newline) lines.pop();
        diff += `--- /dev/null\n+++ ${JSON.stringify(`b/${path}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${newline ? '' : '\\ No newline at end of file\n'}`;
      }
    } catch {
      truncated = true;
    }
    if (Buffer.byteLength(diff) > remaining) {
      truncated = true;
      break;
    }
    remaining -= Buffer.byteLength(diff);
    untracked.push({ path, kind: 'add', diff });
  }
  return {
    cwd,
    readAt: Date.now(),
    staged: staged.text,
    unstaged: unstaged.text,
    untracked,
    truncated,
  };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Return only a canonical public GitHub web URL; never forward remote credentials. */
export function githubRepositoryUrl(remote: string): string | null {
  let path: string;
  const scp = /^(?:[^\s/@:]+@)?github\.com:([^\s]+)$/i.exec(remote);
  if (scp) path = scp[1]!;
  else {
    try {
      const url = new URL(remote);
      if (
        !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== 'github.com' ||
        (url.port && !(url.protocol === 'ssh:' && url.port === '22'))
      )
        return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  // Exact owner/repository paths prevent links to arbitrary GitHub pages or encoded paths.
  const match = /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+?)\/?$/i.exec(path);
  if (!match) return null;
  const repository = match[2]!.replace(/\.git$/i, '');
  if (!repository || repository === '.' || repository === '..') return null;
  return `https://github.com/${match[1]}/${repository}`;
}

export function selectGithubRepository(remotes: { name: string; url: string }[]): string | null {
  const origin = remotes.filter((remote) => remote.name === 'origin');
  const candidates = origin.length ? origin : remotes;
  if (!candidates.length) return null;
  const urls = candidates.map((remote) => githubRepositoryUrl(remote.url));
  const first = urls[0];
  // Without origin, every remote must identify the same repository. Ambiguity hides the link.
  return first && urls.every((url) => url?.toLowerCase() === first.toLowerCase()) ? first : null;
}

export async function readGithubRepository(cwd: string): Promise<string | null> {
  const options = { encoding: 'utf8' as const, timeout: 3000, maxBuffer: 64 * 1024 };
  try {
    const { stdout: inside } = await exec(
      'git',
      ['-C', cwd, 'rev-parse', '--is-inside-work-tree'],
      options,
    );
    if (inside.trim() !== 'true') return null;
    // Git resolves parent checkouts and worktree config; no network or remote commands run.
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'config', '--null', '--get-regexp', '^remote\\..*\\.url$'],
      options,
    );
    const remotes = stdout.split('\0').flatMap((entry) => {
      const separator = entry.indexOf('\n');
      const key = entry.slice(0, separator);
      return separator >= 0 && key.startsWith('remote.') && key.endsWith('.url')
        ? [{ name: key.slice(7, -4), url: entry.slice(separator + 1) }]
        : [];
    });
    return selectGithubRepository(remotes);
  } catch {
    // Missing Git, unreadable config, timeouts and non-repositories leave other actions available.
    return null;
  }
}

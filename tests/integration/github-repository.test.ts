import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  githubRepositoryUrl,
  readGithubRepository,
  selectGithubRepository,
} from '../../src/server/github-repository';
import { createApp } from '../../src/server/http';
import { parseConfig } from '../../src/server/config';
import { GatewayService } from '../../src/server/service';
import { git, githubCheckout } from '../helpers/github-repository';
import { harness, operationId, threadView } from './domain-helpers';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'covro-github-'));
  directories.push(directory);
  return directory;
};

describe('GitHub remote links', () => {
  it.each([
    'https://github.com/example/project.git',
    'https://user:secret@github.com/example/project.git?token=secret#secret',
    'git@github.com:example/project.git',
    'ssh://git@github.com/example/project.git',
    'ssh://git@github.com:22/example/project.git',
    'git://github.com/example/project.git',
    'https://github.com/example/project/',
  ])('normalizes %s without forwarding credentials', (remote) => {
    expect(githubRepositoryUrl(remote)).toBe('https://github.com/example/project');
  });
  it.each([
    'https://gitlab.com/example/project.git',
    'https://github.com.evil.test/example/project',
    'https://github.com@evil.test/example/project',
    'https://github.com:8443/example/project',
    'https://github.com/example/project/tree/main',
    'https://github.com/example/repo%2Fother',
    'https://github.com/example/.git',
    'file:///example/project.git',
    'javascript:alert(1)',
    '/local/repository',
    'git@my-github-alias:example/project.git',
  ])('hides unsupported or invalid remote %s', (remote) => {
    expect(githubRepositoryUrl(remote)).toBeNull();
  });
  it('prefers origin and hides conflicting or unrecognized candidates', () => {
    const origin = { name: 'origin', url: 'git@github.com:example/project.git' };
    const other = { name: 'upstream', url: 'https://github.com/upstream/project.git' };
    expect(selectGithubRepository([other, origin])).toBe('https://github.com/example/project');
    expect(selectGithubRepository([other])).toBe('https://github.com/upstream/project');
    expect(selectGithubRepository([other, { ...origin, name: 'fork' }])).toBeNull();
    expect(selectGithubRepository([other, { ...origin, url: '/local/repo' }])).toBeNull();
    expect(selectGithubRepository([origin, { ...other, name: 'origin' }])).toBeNull();
    expect(selectGithubRepository([other, { name: 'local', url: '/local/repo' }])).toBeNull();
    expect(selectGithubRepository([])).toBeNull();
    expect(
      selectGithubRepository([
        { ...origin, name: 'fork' },
        { name: 'backup', url: 'https://github.com/EXAMPLE/PROJECT.git' },
      ]),
    ).toBe('https://github.com/example/project');
  });
  it('uses real Git from subdirectories and worktrees and re-reads remote changes', async () => {
    const directory = temporaryDirectory();
    const checkout = githubCheckout(join(directory, 'checkout'));
    const nested = join(checkout, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    const worktree = join(directory, 'worktree');
    git(checkout, 'worktree', 'add', '-qb', 'linked', worktree);
    expect(await readGithubRepository(nested)).toBe('https://github.com/example/project');
    expect(await readGithubRepository(worktree)).toBe('https://github.com/example/project');
    git(checkout, 'remote', 'set-url', 'origin', 'https://user:secret@github.com/another/repo.git');
    expect(await readGithubRepository(nested)).toBe('https://github.com/another/repo');
    git(checkout, 'remote', 'remove', 'origin');
    expect(await readGithubRepository(checkout)).toBeNull();
    expect(await readGithubRepository(directory)).toBeNull();
    expect(await readGithubRepository(join(directory, 'missing'))).toBeNull();
  });
  it('supports unassigned workspaces and rejects foreign or missing conversation directories', async () => {
    const h = harness();
    const service = new GatewayService({
      store: h.store,
      projects: h.projects,
      codex: h.codex,
      workspacesRoot: join(h.directory, 'workspaces'),
    });
    try {
      const operation = await service.createThread(null, { clientOperationId: operationId() });
      const id = (operation.result as { threadId: string }).threadId;
      const thread = h.codex.threads.get(id)!;
      expect(await service.getThreadGithubRepository(id)).toEqual({ url: null });
      githubCheckout(thread.cwd);
      await service.setThreadArchived(id, { clientOperationId: operationId(), archived: true });
      h.codex.ready = false;
      expect(await service.getThreadGithubRepository(id)).toEqual({
        url: 'https://github.com/example/project',
      });
      rmSync(thread.cwd, { recursive: true });
      await expect(service.getThreadGithubRepository(id)).rejects.toMatchObject({
        code: 'WORKSPACE_UNAVAILABLE',
      });
      h.codex.threads.set('foreign', threadView('foreign', temporaryDirectory()));
      await expect(service.getThreadGithubRepository('foreign')).rejects.toMatchObject({
        code: 'PROJECT_OWNERSHIP',
      });
    } finally {
      await service.shutdown();
      await h.service.shutdown();
      h.close();
    }
  });

  it('authorizes project and saved conversation directories through HTTP', async () => {
    const h = harness();
    try {
      githubCheckout(h.project);
      const nested = githubCheckout(
        join(h.project, 'nested'),
        'https://github.com/example/nested.git',
      );
      h.codex.threads.set('nested-thread', threadView('nested-thread', nested));
      await h.service.listThreads('project');
      const config = parseConfig({ projects: [] }, join(h.directory, 'config.json'));
      const app = createApp({ config, service: h.service, staticDir: h.directory });
      const request = (path: string) => app.request(`http://127.0.0.1:8787/api/${path}`);
      expect(await (await request('projects/project/github-repository')).json()).toEqual({
        url: 'https://github.com/example/project',
      });
      expect(await (await request('threads/nested-thread/github-repository')).json()).toEqual({
        url: 'https://github.com/example/nested',
      });
      h.codex.ready = false;
      expect((await request('threads/nested-thread/github-repository')).status).toBe(200);
      expect((await request('projects/missing/github-repository')).status).toBe(404);
      h.projects.remove('project');
      expect((await request('threads/nested-thread/github-repository')).status).toBe(404);
      expect((await request('projects/project/github-repository')).status).toBe(404);
    } finally {
      await h.service.shutdown();
      h.close();
    }
  });
});

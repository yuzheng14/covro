import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectClones, validateRepository } from '../../src/server/project-clones.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { gitCloneFixture } from '../helpers/git-clone.js';

let manager: ProjectClones | undefined;
let directory: string;
function setup() {
  directory = mkdtempSync(join(tmpdir(), 'covro-clone-test-'));
  const env = gitCloneFixture(directory);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const projects = new ProjectRegistry([]);
  const register = vi.fn((input) => projects.add(input));
  manager = new ProjectClones(register, (path) =>
    projects.list().some((p) => p.canonicalRoot === path),
  );
  const input = (
    repository = 'https://example.test/project.git',
    path = join(directory, 'target'),
  ) => ({ clientOperationId: randomUUID(), repository, path, name: '克隆项目' });
  return { manager, projects, register, input, env };
}
async function settled(clones: ProjectClones, id: string) {
  await vi.waitFor(() => expect(['cloning', 'cancelling']).not.toContain(clones.get(id).status), {
    timeout: 5000,
  });
  return clones.get(id);
}
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('remote project cloning', () => {
  it.each([
    'https://example.test/repo.git',
    'git@example.test:org/repo.git',
    'ssh://git@example.test:2222/org/repo.git',
  ])('clones %s with real Git, registers and deduplicates retries', async (repository) => {
    const h = setup();
    const input = h.input(repository);
    const first = h.manager.start(input);
    expect(h.manager.start(input)).toEqual(first);
    expect(() => h.manager.start({ ...input, name: 'other' })).toThrow(
      expect.objectContaining({ code: 'CLONE_ID_CONFLICT' }),
    );
    const done = await settled(h.manager, first.id);
    expect(done).toMatchObject({
      status: 'completed',
      progressStage: 'completed',
      project: { name: '克隆项目', available: true },
    });
    expect(readFileSync(join(input.path, 'README.md'), 'utf8')).toBe('# Cloned project\n');
    expect(h.projects.list()).toHaveLength(1);
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.env.COVRO_TEST_GIT_CALLS, 'utf8').trim()).toBe(repository);
    expect(h.manager.start(input)).toEqual(done);
    expect(h.manager.cancel(first.id)).toEqual(done);
  });

  it.each([
    'ext::sh -c bad',
    'ext::bad',
    'file:///tmp/repo',
    '/tmp/repo',
    '--upload-pack=bad',
    'http://host/repo',
    'https://user:secret@host/repo',
    'https://host/repo?token=secret',
    'ssh://user:secret@host/repo',
    'https://host/repo#secret',
    'ssh://-option/repo',
    '-option:repo',
    'git@host:repo\nextra',
  ])('rejects unsafe repository input: %s', (repository) => {
    expect(() => validateRepository(repository)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPOSITORY' }),
    );
  });

  it('protects nonempty directories, symlinks, files, relative paths and unavailable parents', () => {
    const h = setup();
    const path = join(directory, 'existing');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'keep');
    const file = join(directory, 'file');
    writeFileSync(file, 'keep file');
    const link = join(directory, 'link');
    symlinkSync(path, link);
    for (const target of [path, file, link])
      expect(() => h.manager.start(h.input(undefined, target))).toThrow(
        expect.objectContaining({ code: 'CLONE_TARGET_EXISTS' }),
      );
    expect(() => h.manager.start(h.input(undefined, 'relative'))).toThrow(
      expect.objectContaining({ code: 'INVALID_PROJECT_PATH' }),
    );
    expect(() => h.manager.start(h.input(undefined, join(directory, 'missing', 'child')))).toThrow(
      expect.objectContaining({ code: 'CLONE_PARENT_UNAVAILABLE' }),
    );
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('keep');
    expect(h.projects.list()).toEqual([]);
  });

  it('accepts an empty destination and refuses already registered directories', async () => {
    const h = setup();
    const input = h.input();
    mkdirSync(input.path);
    expect((await settled(h.manager, h.manager.start(input).id)).status).toBe('completed');
    expect(() => h.manager.start(h.input())).toThrow(
      expect.objectContaining({ code: 'PROJECT_EXISTS' }),
    );
  });

  it('reports safe authentication and repository errors without leaking raw output', async () => {
    const h = setup();
    for (const mode of ['auth', 'missing']) {
      const input = h.input(`https://example.test/${mode}.git`, join(directory, mode));
      const failed = await settled(h.manager, h.manager.start(input).id);
      expect(failed).toMatchObject({
        status: 'failed',
        progressStage: 'failed',
        errorCode: mode === 'auth' ? 'CLONE_AUTH_FAILED' : 'CLONE_REPOSITORY_UNAVAILABLE',
      });
      expect(failed.error).toMatch(mode === 'auth' ? /认证失败/ : /仓库不存在/);
      expect(JSON.stringify(failed)).not.toMatch(/TOP_SECRET|HIDDEN_TOKEN|user:|example.test/);
    }
    expect(h.projects.list()).toEqual([]);
  });

  it('reports missing Git as a recoverable failure', async () => {
    const h = setup();
    vi.stubEnv('PATH', join(directory, 'no-git'));
    const failed = await settled(h.manager, h.manager.start(h.input()).id);
    expect(failed).toMatchObject({
      status: 'failed',
      progressStage: 'failed',
      errorCode: 'CLONE_GIT_MISSING',
      error: expect.stringContaining('未安装 Git'),
    });
    expect(h.register).not.toHaveBeenCalled();
  });

  it('cancels the process, preserves files, and blocks concurrent paths including parent aliases', async () => {
    const h = setup();
    const input = h.input('https://example.test/slow.git');
    const job = h.manager.start(input);
    await vi.waitFor(() => expect(h.manager.get(job.id).percent).toBe(42), { timeout: 5000 });
    const parentLink = join(directory, 'alias');
    symlinkSync(directory, parentLink);
    for (const target of [input.path, join(parentLink, 'target'), directory])
      expect(() => h.manager.start(h.input(undefined, target))).toThrow(
        expect.objectContaining({ code: 'CLONE_IN_PROGRESS' }),
      );
    expect(() => h.manager.assertIdlePath(input.path)).toThrow();
    // Another actor's files must survive cancellation and must block later clones.
    mkdirSync(input.path);
    writeFileSync(join(input.path, 'keep'), 'preserved');
    h.manager.cancel(job.id);
    h.manager.cancel(job.id);
    expect(await settled(h.manager, job.id)).toMatchObject({
      status: 'cancelled',
      progressStage: 'cancelled',
      errorCode: 'CLONE_CANCELLED',
    });
    expect(readFileSync(join(input.path, 'keep'), 'utf8')).toBe('preserved');
    expect(h.register).not.toHaveBeenCalled();
    expect(() => h.manager.start(h.input())).toThrow(
      expect.objectContaining({ code: 'CLONE_TARGET_EXISTS' }),
    );
  });

  it('retries registration without cloning again and drains active jobs during shutdown', async () => {
    const h = setup();
    h.register.mockImplementationOnce(() => {
      throw new Error('database is full: SECRET');
    });
    const input = h.input();
    const failed = await settled(h.manager, h.manager.start(input).id);
    expect(failed).toMatchObject({
      status: 'registration-failed',
      progressStage: 'registration_failed',
      errorCode: 'CLONE_REGISTRATION_FAILED',
    });
    expect(failed.error).not.toContain('SECRET');
    expect(h.projects.list()).toEqual([]);
    expect(h.manager.retryRegistration(failed.id)).toMatchObject({
      status: 'completed',
      progressStage: 'completed',
    });
    expect(h.manager.get(failed.id).errorCode).toBeUndefined();
    expect(h.register).toHaveBeenCalledTimes(2);
    expect(readFileSync(h.env.COVRO_TEST_GIT_CALLS, 'utf8').trim().split('\n')).toHaveLength(1);
    const slow = h.manager.start(h.input('https://example.test/slow.git', join(directory, 'slow')));
    await h.manager.close();
    expect(h.manager.get(slow.id).status).toBe('interrupted');
  });
});

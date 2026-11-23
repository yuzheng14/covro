import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cloneProjectSchema } from '../../src/shared/validation.js';
import { BackgroundTasks } from '../../src/server/background-tasks.js';
import { ProjectClones } from '../../src/server/project-clones.js';
import type { ProjectClone } from '../../src/shared/types.js';
import { gitCloneFixture } from '../helpers/git-clone.js';
import { captureLogger } from '../fixtures/logging.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
function setup() {
  const log = captureLogger();
  const h = harness(log.logger);
  cleanups.push(h.close);
  cleanups.push(() => h.service.shutdown());
  const env = gitCloneFixture(h.directory);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const history = new BackgroundTasks<ProjectClone>(h.db.database, 'git-clone');
  const input = (repository = 'https://example.test/slow.git', name = 'sample') => ({
    clientOperationId: randomUUID(),
    repository,
    path: join(h.directory, name),
    name,
  });
  return { ...h, ...log, history, input, env };
}
async function terminal(clones: ProjectClones, id: string) {
  await vi.waitFor(() => expect(['cloning', 'cancelling']).not.toContain(clones.get(id).status), {
    timeout: 5000,
  });
  return clones.get(id);
}

it('keeps four independent clones busy for automatic/manual updates and backup admission while chat is idle', async () => {
  const h = setup();
  const jobs = Array.from({ length: 4 }, (_, i) =>
    h.service.cloneProject(h.input(undefined, `clone-${i}`)),
  );
  expect(
    h.service.projectClones
      .list()
      .map((job) => job.id)
      .sort(),
  ).toEqual(jobs.map((job) => job.id).sort());
  expect(() => h.service.cloneProject(h.input(undefined, 'fifth'))).toThrow(
    expect.objectContaining({ code: 'CLONE_LIMIT' }),
  );
  expect(h.service.prepareUpdate('update', false)).toEqual({
    ready: false,
    reason: '等待项目克隆完成或取消',
  });
  expect(h.service.prepareUpdate('backup')).toEqual({
    ready: false,
    reason: '等待项目克隆完成或取消',
  });
  expect(h.service.restartBlockers(true)).toEqual(['clone']);
  expect(h.service.isInMaintenance()).toBe(false);
  h.service.projectClones.cancel(jobs[0]!.id);
  await terminal(h.service.projectClones, jobs[0]!.id);
  expect(h.service.prepareUpdate().ready).toBe(false);
  expect(h.service.projectClones.get(jobs[1]!.id).status).toBe('cloning');
  for (const job of jobs.slice(1)) h.service.projectClones.cancel(job.id);
  for (const job of jobs) await terminal(h.service.projectClones, job.id);
  expect(h.service.prepareUpdate('update', false)).toEqual({ ready: true });
  expect(h.service.isInMaintenance()).toBe(false);
  expect(h.service.prepareUpdate()).toEqual({ ready: true });
  expect(() => h.service.cloneProject(h.input(undefined, 'after-gate'))).toThrow(
    expect.objectContaining({ code: 'GATEWAY_STOPPING' }),
  );
});

it('persists safe results and idempotency across executor recreation without another Git process', async () => {
  const h = setup();
  const input = h.input('https://example.test/project.git');
  const done = await terminal(h.service.projectClones, h.service.cloneProject(input).id);
  await h.service.projectClones.close();
  const register = vi.fn();
  const recovered = new ProjectClones(register, () => false, h.logger, h.history);
  cleanups.push(() => recovered.close());
  expect(recovered.list()).toEqual([done]);
  expect(recovered.start(input)).toEqual(done);
  expect(() => recovered.start({ ...input, repository: 'https://other.test/repo.git' })).toThrow(
    expect.objectContaining({ code: 'CLONE_ID_CONFLICT' }),
  );
  expect(register).not.toHaveBeenCalled();
  expect(readFileSync(h.env.COVRO_TEST_GIT_CALLS, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(JSON.stringify(h.history.load())).not.toContain('example.test');
  expect(done.createdAt).toBeTypeOf('number');
  expect(done.finishedAt).toBeGreaterThanOrEqual(done.createdAt!);
  expect(JSON.stringify(h.records)).not.toContain(h.directory);
  expect(h.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'clone.finished',
        outcome: 'completed',
        cloneId: input.clientOperationId,
      }),
    ]),
  );
});

it('recovers both running and cancelling snapshots as interrupted and never retries automatically', async () => {
  const h = setup();
  for (const status of ['cloning', 'cancelling'] as const)
    h.history.save(
      { id: randomUUID(), path: join(h.directory, status), status, progress: 'safe', percent: 42 },
      'hashed-request',
    );
  const register = vi.fn();
  const recovered = new ProjectClones(register, () => false, h.logger, h.history);
  cleanups.push(() => recovered.close());
  expect(recovered.hasActive).toBe(false);
  expect(recovered.list()).toHaveLength(2);
  for (const job of recovered.list()) {
    expect(job).toMatchObject({
      status: 'interrupted',
      progressStage: 'interrupted',
      errorCode: 'CLONE_INTERRUPTED',
    });
    expect(job.percent).toBeUndefined();
    expect(recovered.cancel(job.id)).toEqual(job);
  }
  expect(h.history.load().every((row) => row.view.status === 'interrupted')).toBe(true);
  expect(register).not.toHaveBeenCalled();
  expect(
    h.records.filter((record) => record.event === 'clone.recovered_interruption'),
  ).toHaveLength(2);
});

it('distinguishes service shutdown from user cancellation and persists each outcome', async () => {
  const h = setup();
  const stop = h.service.cloneProject(h.input(undefined, 'service-stop'));
  const cancel = h.service.cloneProject(h.input(undefined, 'user-cancel'));
  h.service.projectClones.cancel(cancel.id);
  await h.service.projectClones.close();
  const results = h.history.load().map((row) => row.view);
  expect(results.find((job) => job.id === stop.id)?.status).toBe('interrupted');
  expect(results.find((job) => job.id === cancel.id)?.status).toBe('cancelled');
});

it('expires old snapshots while retaining request identities so an old POST cannot clone again', async () => {
  const h = setup();
  const input = h.input('https://example.test/project.git');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(cloneProjectSchema.parse(input)))
    .digest('hex');
  h.history.save(
    { id: input.clientOperationId, path: input.path, status: 'completed', progress: 'safe' },
    fingerprint,
  );
  h.history.forgetSnapshot(input.clientOperationId);
  expect(h.history.load()).toEqual([]);
  expect(h.history.identity(input.clientOperationId)).toBe(fingerprint);
  const register = vi.fn();
  const recovered = new ProjectClones(register, () => false, h.logger, h.history);
  expect(() => recovered.start(input)).toThrow(
    expect.objectContaining({ code: 'CLONE_NOT_FOUND' }),
  );
  expect(register).not.toHaveBeenCalled();
  await recovered.close();
});

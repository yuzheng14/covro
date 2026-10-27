import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, parseFileConfig } from '../../src/server/config';
import { openDatabase } from '../../src/server/db';
import { migrateDatabase } from '../../src/server/db/migrate';
import { OperationStore } from '../../src/server/db/operations';
import { createApp } from '../../src/server/http';
import { ProjectRegistry } from '../../src/server/projects';
import { GatewayService } from '../../src/server/service';
import {
  assertWorkDir,
  projectPathPreview,
  resolveProjectPath,
} from '../../src/server/project-paths';
import { repositoryDirectory } from '../../src/shared/project-path';
import { DomainCodex } from './domain-helpers';
import { gitCloneFixture } from '../helpers/git-clone';

const origin = 'http://127.0.0.1:8787';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'covro-workdir-test-')));
  const path = join(root, 'config.json');
  const workDir = join(root, 'projects');
  mkdirSync(workDir);
  mkdirSync(join(workDir, 'demo'));
  const other = join(root, 'other');
  mkdirSync(other);
  const db = openDatabase(join(root, 'data', 'app.sqlite'));
  migrateDatabase(db.database);
  writeFileSync(path, JSON.stringify({ dataDir: './data' }));
  const service = new GatewayService({
    store: new OperationStore(db.database),
    projects: new ProjectRegistry([], db.database),
    codex: new DomainCodex(),
  });
  let app = createApp({
    config: await loadConfig({ configPath: path, development: false }),
    service,
    staticDir: root,
  });
  cleanups.push(async () => {
    await service.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const get = (url: string) => app.request(origin + url);
  const post = (url: string, value: unknown) =>
    app.request(origin + url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  async function save(workDir?: string) {
    const snapshot = await (await get('/api/config')).json();
    const { workDir: _previous, ...config } = snapshot.saved;
    return post('/api/config', {
      revision: snapshot.revision,
      config: { ...config, ...(workDir ? { workDir } : {}) },
    });
  }
  return {
    root,
    path,
    workDir,
    other,
    get,
    post,
    save,
    async restart() {
      app = createApp({
        config: await loadConfig({ configPath: path, development: false }),
        service,
        staticDir: root,
      });
    },
  };
}

it('persists live workDir changes, resolves relative and absolute imports, and preserves registered paths', async () => {
  const h = await setup();
  expect((await h.post('/api/projects', { path: 'demo' })).status).toBe(400);
  expect(await (await h.get('/api/project-path')).json()).toEqual({ path: '' });
  const saved = await h.save(h.workDir);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    restartRequired: false,
    running: { workDir: h.workDir },
  });
  expect(JSON.parse(readFileSync(h.path, 'utf8')).workDir).toBe(h.workDir);
  expect(await (await h.get('/api/project-path?path=demo')).json()).toEqual({
    workDir: h.workDir,
    path: join(h.workDir, 'demo'),
  });
  const imported = await h.post('/api/projects', { path: 'demo' });
  expect(imported.status).toBe(200);
  const project = await imported.json();
  expect(project.rootPath).toBe(join(h.workDir, 'demo'));
  expect((await h.post('/api/projects', { path: h.other })).status).toBe(200);
  await h.save(h.other);
  await h.restart();
  expect(await (await h.get('/api/project-path')).json()).toMatchObject({ path: h.other });
  const projects = await (await h.get('/api/projects')).json();
  expect(projects.data.find((p: { id: string }) => p.id === project.id).rootPath).toBe(
    join(h.workDir, 'demo'),
  );
  await h.save();
  expect(await (await h.get('/api/project-path')).json()).toEqual({ path: '' });
  expect((await h.post('/api/projects', { path: 'demo' })).status).toBe(400);
});

it('rejects invalid or unavailable workDir without writing and permits absolute overrides when the base disappears', async () => {
  const h = await setup();
  const before = readFileSync(h.path, 'utf8');
  for (const path of ['relative', '', '/tmp/with\0nul'])
    expect(() => parseFileConfig({ workDir: path })).toThrow();
  for (const invalid of [join(h.root, 'missing'), h.path]) {
    const failed = await h.save(invalid);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: { code: 'WORK_DIR_UNAVAILABLE' } });
    expect(readFileSync(h.path, 'utf8')).toBe(before);
  }
  await h.save(h.workDir);
  rmSync(h.workDir, { recursive: true });
  expect((await h.get('/api/project-path')).status).toBe(409);
  expect((await h.post('/api/projects', { path: 'demo' })).status).toBe(409);
  expect((await h.post('/api/projects', { path: h.other })).status).toBe(200);
  expect((await h.save()).status).toBe(200);
});

it('shares workDir with real Git clones and keeps retry identity stable after configuration changes', async () => {
  const h = await setup();
  for (const [key, value] of Object.entries(gitCloneFixture(h.root))) vi.stubEnv(key, value);
  await h.save(h.workDir);
  expect(await (await h.get('/api/project-path?directory=cloned')).json()).toMatchObject({
    path: join(h.workDir, 'cloned'),
  });
  const input = {
    clientOperationId: randomUUID(),
    repository: 'git@example.test:org/cloned.git',
    path: 'cloned',
  };
  const first = await h.post('/api/project-clones', input);
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ path: join(h.workDir, 'cloned') });
  await vi.waitFor(
    async () => {
      expect(
        await (await h.get(`/api/project-clones/${input.clientOperationId}`)).json(),
      ).toMatchObject({ status: 'completed' });
    },
    { timeout: 5000 },
  );
  await h.save(h.other);
  const retry = await h.post('/api/project-clones', input);
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({
    status: 'completed',
    path: join(h.workDir, 'cloned'),
  });
  expect(readFileSync(join(h.workDir, 'cloned', 'README.md'), 'utf8')).toBe('# Cloned project\n');
  expect(readFileSync(join(h.root, 'git-calls'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('normalizes host paths and derives directory suggestions for HTTPS and both SSH forms', async () => {
  const h = await setup();
  for (const repository of [
    'https://example.test/org/demo.git',
    'git@example.test:org/demo.git',
    'ssh://git@example.test:2222/org/demo.git/',
    'https://example.test/org/demo',
  ])
    expect(repositoryDirectory(repository)).toBe('demo');
  for (const repository of [
    '',
    'https://example.test/org/..',
    'https://example.test/org/.git',
    'https://example.test/org/demo?token=secret',
  ])
    expect(repositoryDirectory(repository)).toBe('');
  expect(projectPathPreview('', h.workDir)).toMatchObject({ path: h.workDir });
  expect(projectPathPreview('', h.workDir, 'demo')).toMatchObject({
    path: join(h.workDir, 'demo'),
  });
  expect(projectPathPreview('', undefined, 'demo')).toEqual({ workDir: undefined, path: '' });
  expect(resolveProjectPath('nested/../demo', h.workDir)).toBe(join(h.workDir, 'demo'));
  expect(resolveProjectPath(h.other, join(h.root, 'missing'))).toBe(h.other);
  expect(resolveProjectPath('../other', h.workDir)).toBe(resolve(h.workDir, '../other'));
  expect(() => assertWorkDir(h.path)).toThrow(
    expect.objectContaining({ code: 'WORK_DIR_UNAVAILABLE' }),
  );
});

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { parseConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/http.js';
import { GatewayService } from '../../src/server/service.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { shellActive } from '../../src/shared/shell.js';
import { databaseHarness } from './domain-db-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(confirm = true, unsupportedMethod?: string) {
  const db = databaseHarness();
  const project = realpathSync(db.directory) + '/project';
  mkdirSync(project);
  const second = join(db.directory, 'second');
  mkdirSync(second);
  const log = join(db.directory, 'requests.jsonl');
  const codex = new CodexAdapter({
    binary: process.execPath,
    requestTimeoutMs: 1000,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ logPath: log, unsupportedMethod, codexVersion: '99.0.0' }),
    ],
  });
  const config = parseConfig(
    {
      projects: [
        { id: 'test', name: 'Test', path: project },
        { id: 'second', name: 'Second', path: second },
      ],
    },
    join(db.directory, 'config.json'),
  );
  const service = new GatewayService({
    store: db.store,
    projects: new ProjectRegistry(config.projects),
    codex,
  });
  cleanups.push(async () => {
    await service.shutdown();
    db.close();
  });
  await codex.start();
  if (confirm)
    await service.confirmCompatibility({
      clientOperationId: randomUUID(),
      codexEpoch: codex.epoch,
      codexVersion: service.getSystem().codexVersion!,
      verifiedVersion: service.getSystem().verifiedVersion,
      confirm: true,
    });
  const app = createApp({ config, service, staticDir: db.directory });
  const post = (path: string, body: object, origin = 'http://127.0.0.1:8787') =>
    app.request(`http://127.0.0.1:8787${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const start = async (command: string, projectId = 'test', id = randomUUID()) => {
    const response = await post(`/api/projects/${projectId}/shell`, {
      clientOperationId: id,
      command,
    });
    return { response, op: await response.json(), id };
  };
  const run = (id: string) => service.shell.snapshot().commands.find((entry) => entry.id === id)!;
  const finished = (id: string) =>
    expect.poll(() => Boolean(run(id) && !shellActive(run(id)))).toBe(true);
  return {
    ...db,
    project,
    second,
    service,
    codex,
    app,
    post,
    start,
    run,
    finished,
    requests: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

it('executes in the canonical registered directory, streams both channels, records failure, and deduplicates receipts', async () => {
  const h = await setup();
  const command = "printf 'hello 中文\\n'; pwd; printf 'failure details\\n' >&2; exit 7";
  const { id, op } = await h.start(command);
  expect(op.status).toBe('acknowledged');
  await h.finished(id);
  expect(h.run(id)).toMatchObject({ cwd: h.project, status: 'failed', exitCode: 7 });
  expect(
    h
      .run(id)
      .output.filter((part) => part.stream === 'stdout')
      .map((part) => part.text)
      .join(''),
  ).toContain(`hello 中文\n${h.project}`);
  expect(
    h
      .run(id)
      .output.some((part) => part.stream === 'stderr' && part.text.includes('failure details')),
  ).toBe(true);
  expect((await h.start(command, 'test', id)).op).toEqual(op);
  expect((await h.start('different command', 'test', id)).response.status).toBe(409);
  const exec = h.requests().filter((request) => request.method === 'command/exec');
  expect(exec).toHaveLength(1);
  expect(exec[0].params).toMatchObject({
    cwd: h.project,
    streamStdoutStderr: true,
    tty: false,
    streamStdin: false,
    timeoutMs: 600000,
  });
  expect(exec[0].params).not.toHaveProperty('sandboxPolicy');
  expect(h.requests().some((request) => request.method === 'thread/start')).toBe(false);
  const snapshot = h.service.shell.snapshot();
  expect(h.service.shell.snapshot(snapshot.epoch, snapshot.revision).commands).toEqual([]);
});

it('retains live output independently of browser requests, separates projects and interrupts a running process', async () => {
  const h = await setup();
  const { id } = await h.start("printf 'first\\n'; sleep 0.3; printf 'second\\n'; sleep 30");
  await expect
    .poll(() =>
      h
        .run(id)
        .output.map((part) => part.text)
        .join(''),
    )
    .toContain('first');
  expect(h.run(id).status).toBe('running');
  expect((await h.start('pwd')).op).toMatchObject({ error: { code: 'SHELL_BUSY' } });
  expect(() => h.service.removeProject('test')).toThrow('活动任务');
  expect(h.service.prepareUpdate()).toMatchObject({ ready: false, reason: '等待 Shell 命令结束' });
  const other = await h.start('pwd', 'second');
  await h.finished(other.id);
  expect(
    h
      .run(other.id)
      .output.map((part) => part.text)
      .join(''),
  ).toContain(h.second);
  await expect
    .poll(() =>
      h
        .run(id)
        .output.map((part) => part.text)
        .join(''),
    )
    .toContain('second');
  const response = await h.post(`/api/shell/${id}/interrupt`, { clientOperationId: randomUUID() });
  expect((await response.json()).status).toBe('acknowledged');
  await h.finished(id);
  expect(h.run(id).status).toBe('interrupted');
  expect(h.run(id).exitCode).toBeTypeOf('number');
});

it('enforces existing Origin, maintenance, project and compatibility gates without accepting a client cwd or permission override', async () => {
  const h = await setup(false);
  expect((await h.start('pwd')).op.error.code).toBe('COMPATIBILITY_CONFIRMATION_REQUIRED');
  for (const extra of [
    { cwd: '/tmp' },
    { sandboxPolicy: { type: 'dangerFullAccess' } },
    { command: ' ' },
    { command: 'a\0b' },
  ]) {
    expect(
      (
        await h.post('/api/projects/test/shell', {
          clientOperationId: randomUUID(),
          command: 'pwd',
          ...extra,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await h.post(
        '/api/projects/test/shell',
        { clientOperationId: randomUUID(), command: 'pwd' },
        'https://foreign.test',
      )
    ).status,
  ).toBe(403);
  h.service.setMaintenance(true);
  expect((await h.start('pwd')).response.status).toBe(503);
  h.service.setMaintenance(false);
  const diagnostics = h.service.getSystem();
  await h.service.confirmCompatibility({
    clientOperationId: randomUUID(),
    codexEpoch: h.codex.epoch,
    codexVersion: diagnostics.codexVersion!,
    verifiedVersion: diagnostics.verifiedVersion,
    confirm: true,
  });
  expect((await h.start('pwd', 'unknown')).op.error.code).toBe('PROJECT_NOT_FOUND');
  rmSync(h.project, { recursive: true });
  expect((await h.start('pwd')).op.error.code).toBe('PROJECT_UNAVAILABLE');
  expect(h.requests().some((request) => request.method === 'command/exec')).toBe(false);
});

it('bounds output and keeps the received bytes when the Codex transport disconnects', async () => {
  const h = await setup();
  const noisy = await h.start("head -c 100000 /dev/zero | tr '\\0' x");
  await h.finished(noisy.id);
  expect(h.run(noisy.id).truncated).toBe(true);
  expect(
    Buffer.byteLength(
      h
        .run(noisy.id)
        .output.map((part) => part.text)
        .join(''),
    ),
  ).toBeLessThanOrEqual(65536);
  const unicode = await h.start(
    `node -e 'process.stdout.write("中".repeat(40000)); process.stderr.write("文".repeat(40000))'`,
  );
  await h.finished(unicode.id);
  expect(h.run(unicode.id).truncated).toBe(true);
  expect(
    Buffer.byteLength(
      h
        .run(unicode.id)
        .output.map((part) => part.text)
        .join(''),
    ),
  ).toBeLessThanOrEqual(65536);
  const live = await h.start("printf 'keep this output'; sleep 30");
  await expect
    .poll(() =>
      h
        .run(live.id)
        .output.map((part) => part.text)
        .join(''),
    )
    .toContain('keep this output');
  await h.codex.stop();
  await h.finished(live.id);
  expect(h.run(live.id)).toMatchObject({
    status: 'unknown',
    error: expect.stringContaining('执行结果未知'),
  });
  expect(
    h
      .run(live.id)
      .output.map((part) => part.text)
      .join(''),
  ).toContain('keep this output');
});

it('surfaces an unsupported upstream command interface instead of using an unrestricted host fallback', async () => {
  const h = await setup(true, 'command/exec');
  const { id } = await h.start('pwd');
  await h.finished(id);
  expect(h.run(id)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Method not found'),
  });
  expect(h.service.getSystem().capabilities).not.toContain('command/exec');
});

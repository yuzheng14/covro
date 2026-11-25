import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readGlobalInstructions,
  saveGlobalInstructions,
  MAX_INSTRUCTIONS_BYTES,
  globalInstructionsHome,
} from '../../src/server/global-instructions';
import { captureLogger } from '../fixtures/logging';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'covro-instructions-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('creates and updates UTF-8 instructions, preserving permissions without logging content', async () => {
  const { logger, records } = captureLogger();
  const missing = await readGlobalInstructions(root);
  expect(missing).toEqual({
    content: '',
    revision: 'missing',
    exists: false,
    path: join(root, 'AGENTS.md'),
    overridden: false,
  });
  const created = await saveGlobalInstructions(
    root,
    { content: '# Private instructions 中文\n', revision: missing.revision },
    logger,
  );
  expect(created.exists).toBe(true);
  await chmod(join(root, 'AGENTS.md'), 0o640);
  const saved = await saveGlobalInstructions(
    root,
    { content: '', revision: created.revision },
    logger,
  );
  expect(saved.content).toBe('');
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('');
  expect((await stat(join(root, 'AGENTS.md'))).mode & 0o777).toBe(0o640);
  expect(records.filter((r) => r.event === 'global_instructions.saved')).toHaveLength(2);
  expect(JSON.stringify(records)).not.toContain('Private instructions');
  expect(JSON.stringify(records)).not.toContain(root);
});

test('rejects external changes and serializes competing saves', async () => {
  const { logger, records } = captureLogger();
  await writeFile(join(root, 'AGENTS.md'), 'original');
  const original = await readGlobalInstructions(root);
  await writeFile(join(root, 'AGENTS.md'), 'external');
  await expect(
    saveGlobalInstructions(root, { content: 'overwrite', revision: original.revision }, logger),
  ).rejects.toMatchObject({ code: 'INSTRUCTIONS_CONFLICT' });
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('external');
  const current = await readGlobalInstructions(root);
  const results = await Promise.allSettled(
    ['first', 'second'].map((content) =>
      saveGlobalInstructions(root, { content, revision: current.revision }, logger),
    ),
  );
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  expect(
    records.some(
      (r) =>
        r.event === 'global_instructions.save_failed' && r.errorCode === 'INSTRUCTIONS_CONFLICT',
    ),
  ).toBe(true);
});

test('rejects symbolic links, binary content, and oversized files', async () => {
  const file = join(root, 'AGENTS.md');
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'do not modify');
  await symlink(outside, file);
  await expect(readGlobalInstructions(root)).rejects.toMatchObject({
    code: 'INSTRUCTIONS_UNSUPPORTED',
  });
  await expect(
    saveGlobalInstructions(root, { content: 'overwrite', revision: 'missing' }),
  ).rejects.toMatchObject({ code: 'INSTRUCTIONS_UNSUPPORTED' });
  expect(await readFile(outside, 'utf8')).toBe('do not modify');
  await rm(file);
  await writeFile(file, Buffer.from([0xff, 0x00]));
  await expect(readGlobalInstructions(root)).rejects.toMatchObject({
    code: 'INSTRUCTIONS_UNSUPPORTED',
  });
  await writeFile(file, 'x'.repeat(MAX_INSTRUCTIONS_BYTES + 1));
  await expect(readGlobalInstructions(root)).rejects.toMatchObject({
    code: 'INSTRUCTIONS_TOO_LARGE',
  });
  await expect(
    saveGlobalInstructions(root, {
      content: 'x'.repeat(MAX_INSTRUCTIONS_BYTES + 1),
      revision: 'missing',
    }),
  ).rejects.toMatchObject({ code: 'INSTRUCTIONS_TOO_LARGE' });
});

test('uses configured Codex home before CODEX_HOME and detects active overrides', async () => {
  vi.stubEnv('CODEX_HOME', root);
  try {
    expect(globalInstructionsHome()).toBe(root);
    expect(globalInstructionsHome(join(root, 'configured'))).toBe(join(root, 'configured'));
  } finally {
    vi.unstubAllEnvs();
  }
  await writeFile(join(root, 'AGENTS.md'), 'base');
  const initial = await readGlobalInstructions(root);
  await writeFile(join(root, 'AGENTS.override.md'), 'override instructions');
  expect((await readGlobalInstructions(root)).overridden).toBe(true);
  await expect(
    saveGlobalInstructions(root, { content: 'changed', revision: initial.revision }),
  ).rejects.toMatchObject({ code: 'INSTRUCTIONS_OVERRIDDEN' });
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('base');
  await writeFile(join(root, 'AGENTS.override.md'), '  \n');
  expect((await readGlobalInstructions(root)).overridden).toBe(false);
  await saveGlobalInstructions(root, { content: 'changed', revision: initial.revision });
});

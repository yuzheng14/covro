import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import type { GlobalInstructions, SaveGlobalInstructions } from '../shared/global-instructions.js';
import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';

export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const writes = new Map<string, Promise<unknown>>();
const revision = (content: Buffer) => createHash('sha256').update(content).digest('hex');

type InstructionsFile = Omit<GlobalInstructions, 'path' | 'overridden'>;
export function globalInstructionsHome(configuredHome?: string): string {
  return resolve(configuredHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')));
}
async function readInstructionsFile(
  root: string,
  filename = 'AGENTS.md',
): Promise<InstructionsFile> {
  const path = join(root, filename);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new AppError(
        'INSTRUCTIONS_UNSUPPORTED',
        'AGENTS.md must be a regular file without links',
        409,
      );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new AppError(
          'INSTRUCTIONS_UNSUPPORTED',
          'AGENTS.md must be a regular file without links',
          409,
        );
      if (info.size > MAX_INSTRUCTIONS_BYTES)
        throw new AppError('INSTRUCTIONS_TOO_LARGE', 'AGENTS.md exceeds 256 KiB', 413);
      const bytes = Buffer.alloc(MAX_INSTRUCTIONS_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_INSTRUCTIONS_BYTES)
        throw new AppError('INSTRUCTIONS_TOO_LARGE', 'AGENTS.md exceeds 256 KiB', 413);
      const data = bytes.subarray(0, length);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        if (content.includes('\0')) throw new Error();
      } catch {
        throw new AppError('INSTRUCTIONS_UNSUPPORTED', 'AGENTS.md must contain UTF-8 text', 415);
      }
      return { content, revision: revision(data), exists: true };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { content: '', revision: 'missing', exists: false };
    throw error;
  }
}

async function saveInstructionsFile(
  root: string,
  input: SaveGlobalInstructions,
  logger: Logger = nullLogger,
): Promise<InstructionsFile> {
  const pending = (writes.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const path = join(root, 'AGENTS.md');
      const temporary = join(root, `.AGENTS.md.${randomUUID()}.tmp`);
      try {
        if (input.content.includes('\0'))
          throw new AppError('INSTRUCTIONS_UNSUPPORTED', 'AGENTS.md must contain UTF-8 text', 415);
        if (Buffer.byteLength(input.content, 'utf8') > MAX_INSTRUCTIONS_BYTES)
          throw new AppError('INSTRUCTIONS_TOO_LARGE', 'AGENTS.md exceeds 256 KiB', 413);
        await assertNotOverridden(root);
        await mkdir(root, { recursive: true });
        const current = await readInstructionsFile(root);
        if (current.revision !== input.revision)
          throw new AppError(
            'INSTRUCTIONS_CONFLICT',
            'AGENTS.md changed. Reload before saving.',
            409,
          );
        const mode = current.exists ? (await lstat(path)).mode & 0o777 : 0o644;
        const file = await open(temporary, 'wx', mode);
        try {
          await file.chmod(mode);
          await file.writeFile(input.content, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        if ((await readInstructionsFile(root)).revision !== input.revision)
          throw new AppError(
            'INSTRUCTIONS_CONFLICT',
            'AGENTS.md changed. Reload before saving.',
            409,
          );
        await assertNotOverridden(root);
        if (current.exists) await rename(temporary, path);
        else {
          try {
            await link(temporary, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              throw new AppError(
                'INSTRUCTIONS_CONFLICT',
                'AGENTS.md changed. Reload before saving.',
                409,
              );
            throw error;
          }
          await rm(temporary);
        }
        logger.info('global_instructions.saved', {
          outcome: 'success',
          outputBytes: Buffer.byteLength(input.content),
        });
        return {
          content: input.content,
          revision: revision(Buffer.from(input.content)),
          exists: true,
        };
      } catch (error) {
        logger.warn('global_instructions.save_failed', {
          outcome: 'failed',
          ...errorFields(error),
        });
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  writes.set(root, pending);
  try {
    return await pending;
  } finally {
    if (writes.get(root) === pending) writes.delete(root);
  }
}

async function assertNotOverridden(root: string) {
  const override = await readInstructionsFile(root, 'AGENTS.override.md');
  if (override.content.trim())
    throw new AppError(
      'INSTRUCTIONS_OVERRIDDEN',
      'AGENTS.override.md is active; AGENTS.md is not the effective global file',
      409,
    );
}
export async function readGlobalInstructions(root: string): Promise<GlobalInstructions> {
  const file = await readInstructionsFile(root);
  const override = await readInstructionsFile(root, 'AGENTS.override.md');
  return { ...file, path: join(root, 'AGENTS.md'), overridden: Boolean(override.content.trim()) };
}
export async function saveGlobalInstructions(
  root: string,
  input: SaveGlobalInstructions,
  logger: Logger = nullLogger,
): Promise<GlobalInstructions> {
  const file = await saveInstructionsFile(root, input, logger);
  return { ...file, path: join(root, 'AGENTS.md'), overridden: false };
}

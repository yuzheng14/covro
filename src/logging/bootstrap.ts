import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Retain a bounded tail in-place: a service manager may already hold the append fd. */
export async function trimBootstrap(path: string, maxBytes = 1024 * 1024, keepBytes = 64 * 1024) {
  let file;
  try {
    file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= maxBytes) return;
    const tail = Buffer.alloc(Math.min(keepBytes, info.size));
    const { bytesRead } = await file.read(tail, 0, tail.length, info.size - tail.length);
    await file.truncate(0);
    await file.write(tail.subarray(0, bytesRead), 0, bytesRead, 0);
  } finally {
    await file.close();
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validVersion } from '../shared/versions.js';

import type { CodexIdentity } from '../shared/codex-identity.js';
export type { CodexIdentity } from '../shared/codex-identity.js';

const exec = promisify(execFile);
// Per-process service-manager bookkeeping is different for the short-lived probe job.
const transient = new Set([
  '_',
  'XPC_SERVICE_NAME',
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  'SYSTEMD_EXEC_PID',
  'NOTIFY_SOCKET',
  'WATCHDOG_PID',
  'WATCHDOG_USEC',
]);
export const codexEnvironment = (home?: string): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(home === undefined ? {} : { CODEX_HOME: home }),
});
/** The originator may contain spaces or slashes; the build version follows the complete name. */
export function codexServerVersion(
  userAgent: string,
  override = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
) {
  const name = [override, 'codex_web_ui', 'codex_cli_rs', 'codex'].find(
    (name) => name !== undefined && userAgent.startsWith(`${name}/`),
  );
  if (name === undefined) return null;
  const version = userAgent.slice(name.length + 1).split(/\s/)[0];
  return version && validVersion(version) ? version : null;
}
async function resolveBinary(binary: string, env: NodeJS.ProcessEnv, cwd: string) {
  if (binary.includes('/') || isAbsolute(binary)) return resolve(cwd, binary);
  for (const directory of (env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const filename = resolve(cwd, directory, binary);
    try {
      await access(filename, constants.X_OK);
      if ((await stat(filename)).isFile()) return filename;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  throw new Error('目标启动环境中找不到配置的 Codex 可执行文件');
}
export async function codexFile(filename: string) {
  const info = await stat(filename, { bigint: true });
  if (!info.isFile()) throw new Error('Codex 启动来源不是普通文件');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
export async function probeCodexIdentity(
  binary: string,
  home?: string,
  customTransport = false,
): Promise<CodexIdentity> {
  const env = codexEnvironment(home);
  const cwd = process.cwd();
  const resolved = await resolveBinary(binary, env, cwd);
  const executable = await realpath(resolved);
  const file = await codexFile(executable);
  const { stdout } = await exec(resolved, ['--version'], {
    env,
    cwd,
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const version =
    /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
      stdout.trim(),
    )?.[1] ?? (customTransport ? stdout.trim() : undefined);
  if (!version || (!customTransport && !validVersion(version)))
    throw new Error('目标 Codex 未返回有效的 CLI 版本');
  if ((await realpath(resolved)) !== executable || (await codexFile(executable)) !== file)
    throw new Error('Codex 启动来源在探测期间变化，请重新检查');
  return {
    binary,
    resolved,
    executable,
    file,
    version,
    node: process.execPath,
    cwd,
    // Environment values can contain credentials. Only a digest crosses the control socket.
    environment: createHash('sha256')
      .update(
        JSON.stringify(
          Object.entries(env)
            .filter(([key, value]) => value !== undefined && !transient.has(key))
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest('hex'),
  };
}
export function assertCodexIdentity(actual: CodexIdentity | undefined, expected: CodexIdentity) {
  if (
    !actual ||
    Object.keys(expected).some(
      (key) => actual[key as keyof CodexIdentity] !== expected[key as keyof CodexIdentity],
    )
  )
    throw new Error('Codex 启动来源、环境或版本已变化，请重新检查更新');
}

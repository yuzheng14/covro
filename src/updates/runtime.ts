import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, userInfo } from 'node:os';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { npmPackageName } from '../shared/package.js';
import { compareVersions, validVersion } from '../shared/versions.js';
import type { RuntimeIdentity } from '../shared/updates.js';
import { inspectPackageDirectory } from './registry.js';

const exec = promisify(execFile);
export interface RuntimeTarget extends RuntimeIdentity {
  npm: string;
  npmVersion: string;
  prefix: string;
  globalRoot: string;
  path: string;
  version: string;
  covroCodex?: unknown;
  covroCommit?: string;
  npmConfig?: Record<string, string>;
}
export const runtimeChanged = (target: RuntimeIdentity, current: RuntimeIdentity) =>
  target.node !== current.node ||
  target.nodeVersion !== current.nodeVersion ||
  target.root !== current.root;
export function assertRuntime(actual: RuntimeIdentity | undefined, expected: RuntimeIdentity) {
  if (
    !actual ||
    actual.node !== expected.node ||
    actual.nodeVersion !== expected.nodeVersion ||
    actual.root !== expected.root ||
    actual.entry !== expected.entry
  )
    throw new Error(
      '实际 Node 或 Covro 安装来源与目标不匹配；拒绝激活，请查看升级日志并运行 covro update repair。',
    );
}
export async function verifyRuntimeExecutable(runtime: RuntimeIdentity) {
  const { stdout } = await exec(
    runtime.node,
    ['-p', 'JSON.stringify({node:process.execPath,nodeVersion:process.versions.node})'],
    { env: targetNpmEnvironment(process.env.PATH ?? '/usr/bin:/bin'), timeout: 15_000 },
  );
  const actual = JSON.parse(stdout) as { node: string; nodeVersion: string };
  if (actual.node !== runtime.node || actual.nodeVersion !== runtime.nodeVersion)
    throw new Error(
      '旧 Node 的磁盘路径已被替换，无法保证回滚；请保留旧 Node 安装并核对启动来源后重试。',
    );
}

const probeSchema = z.object({
  node: z.string(),
  nodeVersion: z.string(),
  path: z.string(),
  npmConfig: z.record(z.string(), z.string()).optional(),
});
// Startup files may print banners. Only accept the single explicitly framed Node response.
const marker = 'COVRO_RUNTIME_281=';
const npmConfigKeys = ['prefix', 'userconfig', 'globalconfig'] as const;
const probe = `process.stdout.write('${marker}'+JSON.stringify({node:process.execPath,nodeVersion:process.versions.node,path:process.env.PATH,npmConfig:Object.fromEntries(${JSON.stringify(npmConfigKeys)}.flatMap(k=>{const v=process.env['npm_config_'+k]??process.env['NPM_CONFIG_'+k.toUpperCase()];return v===undefined?[]:[[k,v]]}))})+'\\n')`;
export function targetNpmEnvironment(path: string, config: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of npmConfigKeys) {
    delete env[`NPM_CONFIG_${key.toUpperCase()}`];
    delete env[`npm_config_${key}`];
    if (config[key]) env[`npm_config_${key}`] = config[key];
  }
  return env;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function defaultNodeEnvironment() {
  const shell = userInfo().shell;
  if (!shell || !['bash', 'zsh', 'sh', 'dash', 'fish'].includes(basename(shell)))
    throw new Error(
      '无法识别默认登录 shell；请在目标 Node 的终端使用原部署方式更新并重新安装登录服务。',
    );
  // Do not carry an old nvm/fnm activation into the fresh login. Keep custom tool directories
  // so the user's existing version manager can initialize, but discard concrete Node bins.
  const oldBin = dirname(process.execPath);
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(
      (part) =>
        part &&
        part !== oldBin &&
        !/fnm_multishells|\/node-versions\/|\/\.nvm\/versions\/node\//.test(part),
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...new Set([...path, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'])].join(
      delimiter,
    ),
  };
  for (const key of ['FNM_MULTISHELL_PATH', 'NVM_BIN', 'NVM_INC', 'NODE_OPTIONS', 'NODE_PATH'])
    delete env[key];
  for (const key of npmConfigKeys) {
    delete env[`npm_config_${key}`];
    delete env[`NPM_CONFIG_${key.toUpperCase()}`];
  }
  const { stdout } = await exec(shell, ['-ilc', `node -e ${quote(probe)}`], {
    cwd: homedir(),
    env,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1)
    throw new Error('登录 shell 未返回唯一的默认 Node；请检查 shell 启动配置后重试。');
  return probeSchema.parse(JSON.parse(lines[0]!.slice(marker.length)));
}

async function executable(name: string, path: string) {
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const filename = join(directory, name);
    try {
      await access(filename, constants.X_OK);
      return await realpath(filename);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  throw new Error(
    `目标 Node 环境中找不到 ${name}；请在新终端检查 node、npm 和 npm install -g ${npmPackageName}。`,
  );
}

/** No installs, shell aliases, or inherited npm shebangs participate in target selection. */
export async function resolveRuntimeTarget(
  environment = defaultNodeEnvironment,
): Promise<RuntimeTarget> {
  const found = await environment();
  const node = await realpath(found.node);
  await access(node, constants.X_OK);
  const { stdout } = await exec(node, ['-p', 'process.versions.node'], {
    env: targetNpmEnvironment(found.path, found.npmConfig),
    timeout: 15_000,
  });
  const nodeVersion = stdout.trim();
  // This release supports the same explicit range as package.json. Never silently accept a new major.
  if (
    nodeVersion !== found.nodeVersion ||
    !validVersion(nodeVersion) ||
    compareVersions(nodeVersion, '24.19.0') < 0 ||
    compareVersions(nodeVersion, '25.0.0') >= 0
  )
    throw new Error(
      `目标 Node ${nodeVersion} 不受支持；需要 >=24.19.0 <25，请调整默认 Node 后重试。`,
    );
  const npm = await executable('npm', found.path);
  if ((await realpath(join(dirname(node), 'npm')).catch(() => undefined)) !== npm)
    throw new Error('默认 Node 和 npm 来自不同安装；请修复登录 shell 的 PATH 后重新检查。');
  const npmInfo = JSON.parse(await readFile(join(dirname(npm), '../package.json'), 'utf8')) as {
    name?: string;
  };
  if (basename(npm) !== 'npm-cli.js' || npmInfo.name !== 'npm')
    throw new Error(
      '目标 npm 是无法确认的 shim；请让登录 shell 的 PATH 指向目标 Node 自带的 npm 后重试。',
    );
  const directories = await Promise.all(
    found.path
      .split(delimiter)
      .filter(isAbsolute)
      .map((part) => realpath(part).catch(() => undefined)),
  );
  const path = [
    ...new Set([dirname(node), ...directories.filter((part): part is string => Boolean(part))]),
  ].join(delimiter);
  const options = {
    env: targetNpmEnvironment(path, found.npmConfig),
    cwd: homedir(),
    timeout: 15_000,
  };
  const [prefixResult, rootResult, npmVersionResult] = await Promise.all([
    exec(node, [npm, 'prefix', '--global'], options),
    exec(node, [npm, 'root', '--global'], options),
    exec(node, [npm, '--version'], options),
  ]);
  const prefix = await realpath(prefixResult.stdout.trim());
  const globalRoot = await realpath(rootResult.stdout.trim());
  if (globalRoot !== join(prefix, 'lib/node_modules'))
    throw new Error('目标 npm 全局目录布局不受支持。');
  const root = join(globalRoot, npmPackageName);
  const npmVersion = npmVersionResult.stdout.trim();
  if (!validVersion(npmVersion))
    throw new Error('目标 npm 未返回有效版本，请检查 npm 安装后重试。');
  try {
    const reason = await inspectPackageDirectory(root, globalRoot);
    if (reason) throw new Error(reason);
    const entry = join(root, 'bin/covro.mjs');
    if (
      (await lstat(entry)).isSymbolicLink() ||
      (await realpath(join(prefix, 'bin/covro'))) !== entry
    )
      throw new Error('全局 covro 入口与 npm 安装目录不匹配');
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      covroCodex?: unknown;
      covroCommit?: string;
      gitHead?: string;
    };
    if (metadata.name !== npmPackageName || !validVersion(metadata.version))
      throw new Error('Covro 包身份无效');
    return {
      node,
      nodeVersion,
      npm,
      npmVersion,
      prefix,
      globalRoot,
      root,
      entry,
      path,
      version: metadata.version,
      covroCodex: metadata.covroCodex,
      covroCommit: metadata.covroCommit ?? metadata.gitHead,
      npmConfig: found.npmConfig,
    };
  } catch (error) {
    throw new Error(
      `目标 Node ${nodeVersion} 的全局 Covro 不可用：${(error as Error).message}。请在新终端执行 npm install -g ${npmPackageName} 后重试；当前服务保持运行。`,
      { cause: error },
    );
  }
}

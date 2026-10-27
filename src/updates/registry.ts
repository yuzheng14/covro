import { npmPackageName } from '../shared/package.js';
import { validVersion, compareVersions } from '../shared/versions.js';
export { validVersion, compareVersions } from '../shared/versions.js';
import { realpath, access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ReleaseChannel } from '../shared/updates.js';

export const registry = 'https://registry.npmjs.org';
export const npmTags: Record<ReleaseChannel, string> = {
  stable: 'latest',
  beta: 'beta',
  dev: 'dev',
};
export const releaseSchema = z.object({
  name: z.literal(npmPackageName),
  version: z.string().refine(validVersion),
  gitHead: z.string().optional(),
  covroCommit: z.string().optional(),
  covroCodex: z.unknown().optional(),
});
export function packageMetadataUrl(selector?: string) {
  const url = `${registry}/${encodeURIComponent(npmPackageName)}`;
  return selector === undefined ? url : `${url}/${encodeURIComponent(selector)}`;
}
async function lookupTag(channel: ReleaseChannel, signal?: AbortSignal) {
  const response = await fetch(packageMetadataUrl(npmTags[channel]), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm ${npmTags[channel]} 查询失败（${response.status}）`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('npm 元数据过大');
  return { ...releaseSchema.parse(JSON.parse(body)), channel };
}
export async function lookupRelease(channel: ReleaseChannel, signal?: AbortSignal) {
  // Resolve every allowed source once, then bind the chosen version and its metadata.
  // Stable wins equal precedence; a newer prerelease still wins over an older stable.
  const sources: ReleaseChannel[] = channel === 'stable' ? ['stable'] : ['stable', channel];
  const releases = await Promise.all(sources.map((source) => lookupTag(source, signal)));
  let selected: Awaited<ReturnType<typeof lookupTag>>;
  for (const release of releases)
    if (release && (!selected || compareVersions(release.version, selected.version) > 0))
      selected = release;
  if (!selected)
    throw new Error(
      `npm 尚未发布 Covro 的可用版本（${sources.map((source) => npmTags[source]).join('、')}）`,
    );
  return selected;
}
export async function inspectInstallation(root: string): Promise<string | undefined> {
  try {
    const globalRoot = dirname(dirname(resolve(root)));
    if (!globalRoot.endsWith('/lib/node_modules'))
      return '当前为非 npm 全局安装；请使用原部署方式更新。';
    if (
      (await realpath(join(dirname(dirname(globalRoot)), 'bin/covro'))) !==
      join(resolve(root), 'bin/covro.mjs')
    )
      return '当前 Covro 入口与 npm 全局安装来源不匹配；请使用原部署方式更新。';
    return await inspectPackageDirectory(root, globalRoot);
  } catch {
    return '无法确认可写的 npm 全局安装；请检查 npm、安装目录权限及后台 PATH。';
  }
}

export async function inspectPackageDirectory(root: string, globalRoot: string) {
  const expected = join(await realpath(globalRoot), npmPackageName);
  // npm link and pnpm global point outside the package directory. Following
  // that link would let the worker rename a developer's source checkout.
  if ((await lstat(expected)).isSymbolicLink() || (await realpath(root)) !== expected)
    return '当前为源码、链接或非 npm 全局安装；请使用原部署方式更新。';
  try {
    await lstat(join(expected, '.git'));
    return '当前安装包含 Git 工作区；请使用原部署方式更新。';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await access(root, constants.W_OK);
  return undefined;
}

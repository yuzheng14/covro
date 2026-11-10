import { z } from 'zod';
import { validVersion } from './versions.js';

const version = z.string().max(128).refine(validVersion);
export const codexCompatibilitySchema = z
  .object({
    recommended: version,
    verified: z.array(version).min(1).max(100),
    unsupported: z
      .array(z.object({ version, reason: z.string().min(1).max(500) }).strict())
      .max(100),
  })
  .strict()
  .refine((value) => value.verified.includes(value.recommended), 'Recommended must be verified')
  .refine(
    (value) => !value.unsupported.some((entry) => value.verified.includes(entry.version)),
    'Verified and unsupported versions must not overlap',
  );
export type CodexCompatibilityManifest = z.infer<typeof codexCompatibilitySchema>;
export interface CodexCompatibility {
  version: string | null;
  status: 'verified' | 'unverified' | 'unsupported' | 'unknown';
  manifest?: CodexCompatibilityManifest;
  reason?: string;
}
export interface CodexUpdateConfirmation {
  version: string;
  target: string;
}
export function assessCodexCompatibility(
  metadata: unknown,
  running: string | null,
  basis: 'running' | 'restart' = 'running',
): CodexCompatibility {
  const parsed = codexCompatibilitySchema.safeParse(metadata);
  if (!parsed.success)
    return {
      version: running,
      status: 'unknown',
      reason: '目标包缺少有效的 Codex 兼容声明，无法升级。',
    };
  const manifest = parsed.data;
  if (!running || !validVersion(running))
    return {
      version: running,
      manifest,
      status: 'unknown',
      reason:
        basis === 'restart'
          ? '无法确认重启后的 Codex CLI 版本，请核对启动来源后重新检查。'
          : '无法确认当前 Codex CLI 版本，请先恢复 Codex 连接后重新检查。',
    };
  const unsupported = manifest.unsupported.find((entry) => entry.version === running);
  if (unsupported)
    return {
      version: running,
      manifest,
      status: 'unsupported',
      reason: `目标版本不支持 Codex ${running}：${unsupported.reason}`,
    };
  if (manifest.verified.includes(running))
    return { version: running, manifest, status: 'verified' };
  return {
    version: running,
    manifest,
    status: 'unverified',
    reason: `${basis === 'restart' ? '重启后的' : '当前'} Codex ${running} 与目标 Covro 的组合尚未验证；自动升级已暂停。`,
  };
}
export function requireCodexCompatibility(
  metadata: unknown,
  running: string | null,
  confirmed = false,
  basis: 'running' | 'restart' = 'running',
) {
  const result = assessCodexCompatibility(metadata, running, basis);
  if (result.status !== 'verified' && !(confirmed && result.status === 'unverified'))
    throw new Error(result.reason);
  return result;
}

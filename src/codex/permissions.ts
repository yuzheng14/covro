import { permissionModes } from '../shared/permissions.js';
import type { PermissionCapabilities, PermissionMode, RuntimeSettings } from '../shared/types.js';
import type { ActivePermissionProfile } from './generated/v2/ActivePermissionProfile.js';
import type { AskForApproval } from './generated/v2/AskForApproval.js';
import type { ConfigRequirements } from './generated/v2/ConfigRequirements.js';
import type { SandboxPolicy } from './generated/v2/SandboxPolicy.js';

/** 0.167.0 experimental wire fields omitted by generate-ts without --experimental.
 * initialize.experimentalApi is already enabled. Keep these extensions at the adapter boundary.
 */
export type PermissionSelection = { permissions?: string };
export type ProfileProvenance = { activePermissionProfile?: ActivePermissionProfile | null };
export type PermissionRequirements = ConfigRequirements & {
  allowedApprovalsReviewers?: string[] | null;
};

/** Only classify after seeing the actual boundary, reviewer and profile provenance. */
export function permissionSettings(
  sandbox?: SandboxPolicy,
  approvalPolicy?: AskForApproval | null,
  reviewer?: string | null,
  profile?: ActivePermissionProfile | null,
  cwd?: string,
): Omit<RuntimeSettings, 'model' | 'reasoningEffort' | 'permissionCapabilities'> {
  const result: ReturnType<typeof permissionSettings> = {
    sandbox: sandbox
      ? (
          {
            dangerFullAccess: 'danger-full-access',
            readOnly: 'read-only',
            workspaceWrite: 'workspace-write',
            externalSandbox: 'external-sandbox',
          } as const
        )[sandbox.type]
      : null,
    approvalPolicy:
      typeof approvalPolicy === 'string' ? approvalPolicy : approvalPolicy ? 'granular' : null,
    approvalReviewer: reviewer ?? null,
    networkAccess: !sandbox
      ? null
      : sandbox.type === 'dangerFullAccess'
        ? true
        : sandbox.type === 'externalSandbox'
          ? sandbox.networkAccess === 'enabled'
          : sandbox.networkAccess,
    permissionProfile: profile ?? null,
    writableRoots: sandbox?.type === 'workspaceWrite' ? sandbox.writableRoots : null,
    excludeTmpdirEnvVar: sandbox?.type === 'workspaceWrite' ? sandbox.excludeTmpdirEnvVar : null,
    excludeSlashTmp: sandbox?.type === 'workspaceWrite' ? sandbox.excludeSlashTmp : null,
    permissionMode: null,
  };
  const builtins: string[] = [':workspace', ':read-only', ':danger-full-access'];
  if (
    (profile && (profile.extends !== null || !builtins.includes(profile.id))) ||
    sandbox?.type === 'externalSandbox' ||
    result.approvalPolicy === 'granular'
  ) {
    result.permissionMode = 'custom';
    return result;
  }
  if (!sandbox || !approvalPolicy || !reviewer || profile === undefined) return result;
  const standardBoundary =
    sandbox.type === 'workspaceWrite'
      ? !sandbox.networkAccess &&
        !sandbox.excludeTmpdirEnvVar &&
        !sandbox.excludeSlashTmp &&
        sandbox.writableRoots.every((root) => root === cwd)
      : sandbox.type === 'readOnly'
        ? !sandbox.networkAccess
        : sandbox.type === 'dangerFullAccess';
  result.permissionMode =
    (Object.keys(permissionModes) as PermissionMode[]).find((mode) => {
      const preset = permissionModes[mode];
      return (
        standardBoundary &&
        result.sandbox === preset.sandbox &&
        approvalPolicy === preset.approvalPolicy &&
        reviewer === preset.approvalReviewer &&
        (!profile || profile.id === preset.profile)
      );
    }) ?? 'custom';
  return result;
}

export function permissionCapabilities(
  requirements: PermissionRequirements | null,
  autoReview: boolean,
  unavailableReason?: string,
): PermissionCapabilities {
  return {
    ...(unavailableReason ? { unavailableReason } : {}),
    autoReview: autoReview && requirements?.featureRequirements?.guardian_approval !== false,
    allowedSandboxModes: requirements?.allowedSandboxModes ?? null,
    allowedApprovalPolicies:
      requirements?.allowedApprovalPolicies?.filter(
        (policy): policy is string & AskForApproval => typeof policy === 'string',
      ) ?? null,
    allowedReviewers: requirements?.allowedApprovalsReviewers ?? null,
    allowedProfiles: requirements?.allowedPermissionProfiles
      ? Object.keys(requirements.allowedPermissionProfiles).filter(
          (id) => requirements.allowedPermissionProfiles?.[id] === true,
        )
      : null,
    autoReviewRequiredModels: requirements?.autoReview?.requiredOnModels ?? [],
  };
}

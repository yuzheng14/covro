import type { SystemInfo } from '../../shared/types';
import type { ConnectionState } from './realtime';

const protectedOperations = new Set([
  'create',
  'fork',
  'resume',
  'rename',
  'send',
  'steer',
  'resolve',
  'archive',
  'compact',
  'review',
  'saveModelDefaults',
  'liveSettings',
]);

/** A dismissal never applies to a different runtime, executable version or verified baseline. */
export function compatibilityFingerprint(system?: SystemInfo) {
  return system
    ? JSON.stringify([system.codexEpoch, system.codexVersion, system.verifiedVersion])
    : undefined;
}

export function compatibilityConfirmationRequired(system?: SystemInfo) {
  return system?.compatibilityConfirmation === 'required';
}

export function shouldOpenCompatibilityDialog(
  system: SystemInfo | undefined,
  dismissedFingerprint: string | undefined,
  reopenedFingerprint?: string,
) {
  const fingerprint = compatibilityFingerprint(system);
  return Boolean(
    compatibilityConfirmationRequired(system) &&
    fingerprint &&
    (dismissedFingerprint !== fingerprint || reopenedFingerprint === fingerprint),
  );
}

export function canConfirmCompatibility(
  system: SystemInfo | undefined,
  connection: ConnectionState,
  authRequired: boolean,
) {
  return Boolean(
    compatibilityConfirmationRequired(system) &&
    system?.ready &&
    system.authenticated === true &&
    system.codexVersion &&
    connection === 'connected' &&
    !authRequired,
  );
}

export function operationNeedsCompatibilityConfirmation(kind: string, system?: SystemInfo) {
  return protectedOperations.has(kind) && compatibilityConfirmationRequired(system);
}

/** Build an explicit new decision only from current server state, never from an old receipt. */
export function compatibilityConfirmationInput(
  expectedFingerprint: string,
  freshSystem: SystemInfo | undefined,
  connection: ConnectionState,
  authRequired: boolean,
) {
  if (
    !freshSystem?.codexVersion ||
    compatibilityFingerprint(freshSystem) !== expectedFingerprint ||
    !canConfirmCompatibility(freshSystem, connection, authRequired)
  )
    return undefined;
  return {
    codexEpoch: freshSystem.codexEpoch,
    codexVersion: freshSystem.codexVersion,
    verifiedVersion: freshSystem.verifiedVersion,
    confirm: true as const,
  };
}

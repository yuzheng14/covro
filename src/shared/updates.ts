import type {
  CodexCompatibility,
  CodexCompatibilityManifest,
  CodexUpdateConfirmation,
} from './codex-compatibility.js';
export const releaseChannels = ['stable', 'beta', 'dev'] as const;
export type ReleaseChannel = (typeof releaseChannels)[number];
export interface UpdateSettings {
  channel: ReleaseChannel;
  automatic: boolean;
}
export type UpdatePhase =
  'installing' | 'waiting' | 'stopping' | 'verifying' | 'succeeded' | 'rolledBack' | 'failed';
export interface RuntimeIdentity {
  node: string;
  nodeVersion: string;
  root: string;
  entry: string;
  npm?: string;
  npmVersion?: string;
  globalRoot?: string;
}
export interface UpdateRun {
  id: string;
  from: string;
  target: string;
  /** Subscribed channel after activation, independent of the candidate's source. */
  channel: ReleaseChannel;
  /** Optional for update records created by older versions. */
  sourceChannel?: ReleaseChannel;
  commit?: string;
  phase: UpdatePhase;
  message: string;
  startedAt: number;
  updatedAt: number;
  committed?: boolean;
  runtime?: { from: RuntimeIdentity; target: RuntimeIdentity; actual?: RuntimeIdentity };
  codex?: { version: string; manifest: CodexCompatibilityManifest; confirmedUnverified: boolean };
}
export interface UpdateStatus {
  version: string;
  commit?: string;
  source: 'npm';
  codex: CodexCompatibility;
  settings: UpdateSettings;
  available?: {
    version: string;
    requestedChannel: ReleaseChannel;
    /** Actual npm source of the selected version. */
    channel: ReleaseChannel;
    commit?: string;
    downgrade: boolean;
    codex: CodexCompatibility;
  };
  checkedAt?: number;
  checkError?: string;
  supported: boolean;
  unsupportedReason?: string;
  run?: UpdateRun;
  runtime?: {
    current: RuntimeIdentity;
    target?: RuntimeIdentity;
    migration: boolean;
    error?: string;
  };
}
export const updateActive = (run?: UpdateRun) =>
  Boolean(run && ['installing', 'waiting', 'stopping', 'verifying'].includes(run.phase));
export interface UpdateController {
  status(): Promise<UpdateStatus>;
  check(channel?: ReleaseChannel): Promise<UpdateStatus>;
  configure(settings: UpdateSettings): Promise<UpdateStatus>;
  start(input: {
    clientOperationId: string;
    channel?: ReleaseChannel;
    allowDowngrade?: boolean;
    codexConfirmation?: CodexUpdateConfirmation;
  }): Promise<UpdateStatus>;
  close(): void;
}

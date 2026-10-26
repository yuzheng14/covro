/** Browser-safe application contract. Upstream RPC types stay in src/codex. */
export type RunStatus =
  | 'idle'
  | 'running'
  | 'waitingApproval'
  | 'waitingInput'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';
export interface Settings {
  model?: string;
  reasoningEffort?: string;
  /** fast opts in; null explicitly clears Fast instead of inheriting it. */
  serviceTier?: 'fast' | null;
  /** Atomic user selection. Omitted permissions always inherit Codex's actual config. */
  permissionMode?: PermissionMode;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  approvalReviewer?: 'user' | 'auto_review';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
export type PermissionMode = 'ask' | 'auto-review' | 'full-access' | 'read-only';
export interface PermissionCapabilities {
  unavailableReason?: string;
  autoReview: boolean;
  allowedSandboxModes: string[] | null;
  allowedApprovalPolicies: string[] | null;
  allowedReviewers: string[] | null;
  allowedProfiles: string[] | null;
  autoReviewRequiredModels: string[];
}
/** Values reported by Codex; missing values are never replaced by guessed defaults. */
export interface RuntimeSettings {
  model: string | null;
  reasoningEffort: string | null;
  /** null is reported standard speed; omitted means the upstream did not report it. */
  serviceTier?: string | null;
  sandbox?: Settings['sandbox'] | 'external-sandbox' | null;
  approvalPolicy?: Settings['approvalPolicy'] | 'granular' | null;
  approvalReviewer?: string | null;
  networkAccess?: boolean | null;
  permissionMode?: PermissionMode | 'custom' | null;
  permissionProfile?: { id: string; extends: string | null } | null;
  writableRoots?: string[] | null;
  excludeTmpdirEnvVar?: boolean | null;
  excludeSlashTmp?: boolean | null;
  permissionCapabilities?: PermissionCapabilities;
}
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  canonicalRoot: string;
  workspaceKey: string;
  available: boolean;
  error?: string;
}
export interface CreateProjectInput {
  path: string;
  name?: string;
}
export interface CloneProjectInput extends CreateProjectInput {
  clientOperationId: string;
  repository: string;
}
export interface ProjectClone {
  id: string;
  path: string;
  name?: string;
  status: 'cloning' | 'cancelling' | 'cancelled' | 'failed' | 'registration-failed' | 'completed';
  progress: string;
  /** Stable presentation codes; legacy progress/error text remains available for diagnostics. */
  progressStage?:
    | 'connecting'
    | 'receiving'
    | 'resolving'
    | 'checking_out'
    | 'counting'
    | 'compressing'
    | 'cancelling'
    | 'completed'
    | 'registration_failed'
    | 'timed_out'
    | 'cancelled'
    | 'failed';
  errorCode?:
    | 'CLONE_GIT_MISSING'
    | 'CLONE_AUTH_FAILED'
    | 'CLONE_HOST_KEY_FAILED'
    | 'CLONE_REPOSITORY_UNAVAILABLE'
    | 'CLONE_NETWORK_FAILED'
    | 'CLONE_TARGET_NOT_EMPTY'
    | 'CLONE_DISK_FULL'
    | 'CLONE_FAILED'
    | 'CLONE_REGISTRATION_FAILED'
    | 'CLONE_TIMED_OUT'
    | 'CLONE_CANCELLED';
  percent?: number;
  error?: string;
  project?: Project;
}
export interface RenameProjectInput {
  name: string;
}
export interface ReorderProjectsInput {
  projectIds: string[];
}
export interface FileChange {
  path: string;
  kind: string;
  diff: string;
}
/** Observed automatic review only; it is never a request for user authorization. */
export interface AutoReviewView {
  reviewId: string;
  targetItemId?: string;
  status: 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted' | 'unknown';
  actionLabel: string;
  actionSummary: string;
  /** Structured application labels; values remain verbatim upstream data. */
  presentation?: { kind: string; parts: { label: string; value: string }[] };
  cwd?: string;
  rationale?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  userAuthorization?: 'unknown' | 'low' | 'medium' | 'high';
  startedAtMs: number;
  completedAtMs?: number;
}
export interface ItemView {
  id: string;
  type: string;
  status?: string;
  text?: string;
  images?: string[];
  imageCount?: number;
  command?: string;
  cwd?: string;
  output?: string;
  changes?: FileChange[];
  details?: unknown;
  truncated?: boolean;
  error?: string;
  autoReview?: AutoReviewView;
  delivery?: 'async';
  questions?: AsyncQuestion[];
  questionReplies?: AsyncQuestionReply[];
}
export interface AsyncQuestion {
  title: string;
  options: string[] | null;
}
export interface AsyncQuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}
export interface TurnErrorMetadata {
  errorCode?: string;
  errorDetails?: string;
}
export interface TurnView extends TurnErrorMetadata {
  /** Original turn for a gateway capacity continuation; execution IDs remain native. */
  retryOf?: string;
  id: string;
  threadId: string;
  status: RunStatus;
  /** Upstream Unix timestamps converted to milliseconds; absent in older history. */
  startedAt?: number;
  completedAt?: number;
  /** Upstream duration for the entire turn, in milliseconds; never measured by the browser. */
  durationMs?: number;
  /** Output tokens across this turn's model responses; absent if collection was incomplete. */
  outputTokens?: number;
  items: ItemView[];
  diff?: string;
  error?: string;
  /** Codex's upstream retry state; independent of the browser's gateway connection. */
  reconnect?: TurnErrorMetadata & { status: 'retrying' | 'failed'; message: string };
}
export interface CapacityRetryView {
  rootTurnId: string;
  turnId: string;
  status: 'waiting' | 'retrying' | 'cancelled' | 'stopped';
  /** Upcoming attempt while waiting; current attempt after dispatch. */
  attempt: number;
  limit: number;
  nextAttemptAt?: number;
  reason?: 'progress' | 'native' | 'limit' | 'error';
}
export interface ThreadView {
  capacityRetry?: CapacityRetryView;
  /** Native Codex archive state, read from its index and lifecycle notifications. */
  archived?: boolean;
  id: string;
  runtimeSettings?: RuntimeSettings;
  forkedFromId?: string;
  projectId: string | null;
  cwd: string;
  source: string;
  /** Client recorded at creation; independent of the current executor. */
  originator?: string | null;
  title: string;
  status: RunStatus;
  turns: TurnView[];
  managed: boolean;
  /** Last definite resume failure; cleared on retry, successful acquisition or runtime reset. */
  resumeError?: ApiError;
  updatedAt?: number;
  actions: PendingAction[];
  historyTruncated?: boolean;
  /** Present on a paged history window; turns are in chronological order. */
  history?: { olderCursor: string | null };
  /** Native preview/history evidence, also available when a response omits turns. */
  hasMessages?: boolean;
  /** False for an unsent draft; pending executions remain visible until resolved. */
  historyVisible?: boolean;
  execution?: ExecutionMarker;
}
export type ThreadSummary = Pick<
  ThreadView,
  | 'id'
  | 'forkedFromId'
  | 'projectId'
  | 'source'
  | 'originator'
  | 'title'
  | 'status'
  | 'managed'
  | 'updatedAt'
  | 'archived'
  | 'historyVisible'
> & {
  pendingActionCount: number;
  /** Stable identity of the latest known turn; absent when history is not loaded. */
  lastTurnId?: string;
  lastTurnStatus?: RunStatus;
};
export interface Question {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[];
}
export interface ActionOption {
  id: string;
  label: string;
}
export type ElicitationValue = string | number | boolean | string[];
export interface ElicitationField {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multiEnum';
  required: boolean;
  options?: { value: string; label: string }[];
  default?: ElicitationValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
}
export interface ElicitationRequest {
  serverName: string;
  mode: 'form' | 'url';
  /** Message-only approval; persistence is offered only when advertised by this request. */
  approval?: { allowSession: boolean };
  url?: string;
  fields?: ElicitationField[];
  schemaError?: string;
}
export interface PermissionRequest {
  network?: boolean | null;
  fileSystem?: {
    read: string[];
    write: string[];
    entries: { path: string; access: string }[];
    globScanMaxDepth?: number;
  };
}
export interface PendingAction {
  blocking?: boolean;
  actionId: string;
  codexEpoch: string;
  rpcId: string | number;
  kind:
    'command' | 'file' | 'questions' | 'network' | 'permissions' | 'elicitation' | 'unsupported';
  threadId?: string;
  turnId?: string;
  status: 'pending' | 'responding' | 'responded' | 'expired';
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  details?: unknown;
  options: ActionOption[];
  questions?: Question[];
  permissionRequest?: PermissionRequest;
  elicitation?: ElicitationRequest;
}
export type ActionResolution =
  | { decision: string; content?: Record<string, ElicitationValue>; persist?: 'session' }
  | { answers: Record<string, string[]> };
export interface OperationInput {
  clientOperationId: string;
}
/** Saved together, independently of any thread's pending runtime settings. */
export interface ModelDefaults {
  model: string;
  reasoningEffort: string | null;
}
export interface SaveModelDefaultsInput extends OperationInput {
  settings: ModelDefaults;
}
export interface ModelDefaultsResult {
  status: 'ok' | 'okOverridden';
}
export interface ArchiveThreadInput extends OperationInput {
  archived: boolean;
}
export interface ConfirmCompatibilityInput extends OperationInput {
  codexEpoch: string;
  codexVersion: string;
  verifiedVersion: string;
  confirm: true;
}
export interface CreateThreadInput extends OperationInput {
  settings?: Settings;
}
export type ForkThreadInput = CreateThreadInput;
export interface RenameThreadInput extends OperationInput {
  name: string;
}
export interface ResumeThreadInput extends CreateThreadInput {
  /** Kept for older clients; writer ownership is now checked by Codex, not this flag. */
  confirmExternalStopped?: boolean;
}
export interface TaskMessage {
  text: string;
  images?: string[];
}
export interface StartTurnInput extends CreateThreadInput, TaskMessage {}
export type StartReviewInput = OperationInput;
export interface SteerInput extends OperationInput, TaskMessage {
  expectedTurnId: string;
}
export interface RetryTurnInput extends CreateThreadInput {
  expectedTurnId: string;
}
export interface InterruptInput extends OperationInput {
  expectedTurnId: string;
}
export interface ResolveActionInput extends OperationInput {
  resolution: ActionResolution;
}
export interface ReconcileInput extends OperationInput {
  confirmEnded: true;
}
export type OperationStatus = 'accepted' | 'dispatching' | 'acknowledged' | 'failed' | 'unknown';
export interface ApiError {
  code: string;
  message: string;
  clientOperationId?: string;
  details?: unknown;
}
export interface ExecutionMarker {
  operationId: string;
  threadId: string;
  turnId?: string;
  workspaceKey: string;
  codexEpoch: string;
  ended: boolean;
}
export interface Operation {
  clientOperationId: string;
  kind: string;
  target: string;
  status: OperationStatus;
  result?: unknown;
  error?: ApiError;
  createdAt: number;
  updatedAt: number;
  execution?: ExecutionMarker;
  reconciliation?: { at: number; decision: string };
}
export interface ThreadPage {
  data: ThreadView[];
  nextCursor: string | null;
}
/** A mutation receipt carries the same overview boundary as its real-time notification. */
export interface ThreadMutationResult {
  threadId: string;
  summary: ThreadSummary;
  cursor: Cursor;
}

export interface ThreadSummaryPage {
  data: ThreadSummary[];
  nextCursor: string | null;
  cursor: Cursor;
}
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers?: string[];
}
export interface SystemInfo {
  ready: boolean;
  connection: 'starting' | 'ready' | 'unavailable';
  codexVersion: string | null;
  verifiedVersion: string;
  compatibility: 'verified' | 'unverified' | 'unavailable';
  compatibilityConfirmation: 'not-required' | 'required' | 'confirmed';
  codexEpoch: string;
  authenticated: boolean | null;
  authMode: 'local' | 'cloudflare-access';
  models: ModelInfo[];
  capabilities: string[];
  error?: string;
  demo: boolean;
}
export interface Cursor {
  serverEpoch: string;
  seq: number;
}
export interface SubscribeMessage {
  type: 'subscribe';
  threadId: string;
  after?: Cursor;
}
/** Live-only completion metadata; never replayed from conversation history. */
export interface TurnCompletion {
  threadId: string;
  turnId: string;
  projectId: string | null;
  title: string;
  status: 'completed' | 'failed' | 'interrupted';
}
export interface AttentionTarget {
  kind: 'action' | 'question';
  id: string;
}
/** Live-only signal for a newly actionable request. Never replayed from history. */
export interface AttentionRequest {
  threadId: string;
  projectId: string | null;
  title: string;
  kind: 'answer' | 'approval';
  target: AttentionTarget;
}
export type ServerMessage =
  | { type: 'snapshot'; cursor: Cursor; threadId: string; data: ThreadView }
  | {
      type: 'event';
      cursor: Cursor;
      threadId?: string;
      kind:
        | 'thread'
        | 'threadSummary'
        | 'runtime'
        | 'operation'
        | 'projects'
        | 'turnCompletion'
        | 'attentionRequest';
      payload:
        | ThreadView
        | ThreadSummary
        | SystemInfo
        | Operation
        | Project[]
        | TurnCompletion
        | AttentionRequest;
    }
  | { type: 'error'; error: ApiError };

export interface TextFile {
  path: string;
  content: string;
}

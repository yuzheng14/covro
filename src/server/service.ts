import type { SaveGlobalDefaultsInput } from '../shared/global-defaults.js';
import {
  globalInstructionsHome,
  readGlobalInstructions,
  saveGlobalInstructions,
} from './global-instructions.js';
import type { SaveGlobalInstructions } from '../shared/global-instructions.js';
import { questionAnswers } from '../shared/question-resolution.js';
import { asyncQuestionId, parseQuestionReplies } from '../shared/async-questions.js';
import {
  pendingQuestionCatalog,
  questionEvidence,
  type QuestionHistory,
} from './pending-questions.js';
import type { PendingQuestionsPage, QuestionLocation } from '../shared/pending-questions.js';
import { canTrackQuestions } from '../shared/pending-questions.js';
import { QuestionTrackingStore } from './db/question-tracking.js';
import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { logContext, withLogContext } from '../logging/context.js';
import { hasSkillToken, type SkillReference } from '../shared/skills.js';
import { referenceMessage, validateReferencePath, type ReferenceScope } from './file-references.js';
import type {
  FileReference,
  FileSearchQuery,
  FileSearchResult,
} from '../shared/file-references.js';
import { containsPath } from './projects.js';
import type { CodexClient, CodexDiagnostics, CodexEvent } from '../codex/types.js';
import type { StreamedItem } from './thread-patch.js';
import { CapacityRetries, type CapacityAttempt } from './capacity-retry.js';
import { isModelCapacityError } from '../shared/turn-errors.js';
import { randomUUID } from 'node:crypto';
import type { GoalMutation } from '../shared/thread-goal.js';
import { attentionKey, pendingAttention } from '../shared/thread-attention.js';
import { ShellService } from './shell.js';
import { assertProjectInstructionsMissing, PROJECT_INIT_PROMPT } from './project-init.js';
import { recapInput } from './thread-recap.js';
import { readGithubRepository } from './github-repository.js';
import { readWorkspaceDiff } from './workspace-diff.js';
import type { StartShellInput } from '../shared/shell.js';
import { realpathSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { WorkspaceRegistry } from './workspaces.js';
import { UNASSIGNED_SCOPE } from '../shared/workspace-scope.js';
import { AppError } from '../shared/errors.js';
import { threadNameError } from '../shared/thread-name.js';
import { mergeUserMessage, submittedUserMessage } from '../shared/user-message.js';
import {
  validateElicitationResolution,
  validatePermissionResolution,
} from '../shared/elicitation.js';
import { toThreadSummary } from '../shared/thread-summary.js';
import type {
  DismissQuestionsInput,
  ArchiveThreadInput,
  ConfirmCompatibilityInput,
  CreateProjectInput,
  CloneProjectInput,
  CreateThreadInput,
  CreateSessionInput,
  Cursor,
  ForkThreadInput,
  InterruptInput,
  ItemView,
  Operation,
  OperationInput,
  SaveModelDefaultsInput,
  PendingAction,
  ReconcileInput,
  RenameProjectInput,
  ReorderProjectsInput,
  RenameThreadInput,
  ResolveActionInput,
  ResumeThreadInput,
  ServerMessage,
  StartTurnInput,
  UpdateLiveSettingsInput,
  RetryTurnInput,
  Settings,
  StartReviewInput,
  SteerInput,
  SystemInfo,
  ThreadPage,
  ThreadSummaryPage,
  ThreadView,
} from '../shared/types.js';
import {
  OperationStore,
  requestDigest,
  StoreConflict,
  type ExecutionMarker,
  type OperationRow,
} from './db/operations.js';
import { EventHub } from './events.js';
import { TurnUsageStore } from './db/turn-usage.js';
import { Projection, isActive, isTerminal } from './projection.js';
import { ProjectRegistry } from './projects.js';
import { BackgroundTasks } from './background-tasks.js';
import { ProjectClones } from './project-clones.js';
import { renderThreadExport } from './thread-export.js';
import { HISTORY_PAGE_SIZE, historyCursor } from '../codex/history-cursor.js';
import { readLocalImage } from './images.js';
import { temporaryFileRoots, type FileScope } from './local-files.js';
import { readLocalMarkdown } from './markdown.js';
import { readLocalText } from './text-files.js';
import { readLocalJson } from './json-files.js';
import { sessionCreationResult } from './session-creation.js';
import type { RestartBlocker, RestartRequest } from '../shared/service-restart.js';
import { createSessionLoopSchema, createSessionSchema } from '../shared/validation.js';
import {
  type CreateSessionLoop,
  type SessionLoopAction,
  type SessionLoopResult,
} from '../shared/session-loop.js';
import type { AppTransaction } from './db/index.js';
import { SessionLoopStore, sessionLoopView, type SessionLoopRow } from './db/session-loops.js';

function deferLiveToolOutput(item: ItemView): ItemView {
  if (item.status !== 'completed' || item.outputDeferred || item.error) return item;
  if (item.type === 'commandExecution' && item.output)
    return { ...item, output: '', outputDeferred: true };
  if (item.type !== 'mcpToolCall' || !item.details || typeof item.details !== 'object') return item;
  const details = item.details as Record<string, unknown>;
  const result = details.result as Record<string, unknown> | null | undefined;
  if (
    details.error != null ||
    !Array.isArray(result?.content) ||
    !result.content.length ||
    result.structuredContent != null ||
    result._meta != null ||
    !result.content.every((part) => part?.type === 'text' && typeof part.text === 'string') ||
    !result.content.some((part) => part.text.length)
  )
    return item;
  return { ...item, outputDeferred: true, details: { ...details, result: null } };
}

export interface GatewayOptions {
  logger?: Logger;
  store: OperationStore;
  projects: ProjectRegistry;
  workspacesRoot?: string;
  codexHome?: string;
  codex: CodexClient;
  limits?: { eventBytes: number; itemBytes: number; wsBytes?: number };
  authMode?: SystemInfo['authMode'];
  demo?: boolean;
  maintenancePending?: () => boolean;
}

/** Coordinates durable intent, upstream effects, and the recoverable browser projection. */
export class GatewayService {
  private readonly logger: Logger;
  private readonly capacityRetries: CapacityRetries;
  private readonly loops: SessionLoopStore;
  private loopSchedulerStopped = false;
  private loopTimer?: ReturnType<typeof setInterval>;
  private loopTick?: Promise<void>;
  private loopsOffline = false;
  private readonly manualStarts = new Map<string, number>();
  readonly projectClones: ProjectClones;
  readonly shell: ShellService;
  readonly events: EventHub;
  readonly projection: Projection;
  private readonly store: OperationStore;
  private readonly turnUsage: TurnUsageStore;
  private readonly questionTracking: QuestionTrackingStore;
  private readonly questionHistories = new Map<string, QuestionHistory>();
  private readonly projects: ProjectRegistry;
  private readonly workspaces: WorkspaceRegistry;
  private readonly codex: CodexClient;
  private readonly removeListener: () => void;
  private readonly fileTemporaryRoots = temporaryFileRoots();
  private accepting = true;
  private maintenance = false;
  private maintenanceReason: 'update' | 'backup' | 'restart' = 'update';
  private httpMutations = 0;
  private currentEpoch: string;
  private confirmedCompatibility: string | undefined;
  private readonly archiveChanges = new Set<string>();
  private readonly archiveRevisions = new Map<string, number>();
  private readonly turnBaselines = new Map<string, Set<string>>();
  private readonly renameChanges = new Set<string>();
  private readonly goalWrites = new Set<string>();
  private readonly reads = new Map<string, Promise<ThreadView>>();
  private readonly resumes = new Map<string, Promise<void>>();
  private readonly executionReads = new Map<string, Promise<void>>();
  private readonly summaries = new Map<string, string>();
  // Request ordering only: title values always come from app-server.
  private titleReadSequence = 0;
  private readonly titleReads = new Map<string, number>();
  private readonly liveSettingsWrites = new Map<string, Promise<unknown>>();
  // A status/title/history update must not discard a lifecycle response's full configuration.
  private runtimeSettingsSequence = 0;
  private readonly runtimeSettingsUpdates = new Map<string, number>();
  private readonly inFlightOperations = new Set<string>();
  private readonly instructionsHome: string;
  private readonly instructionWrites = new Set<Promise<unknown>>();
  private readonly defaultWrites = new Set<Promise<unknown>>();
  private readonly pendingThreadCreations = new Map<string, string>();
  private readonly capacityLinks = new Map<string, Map<string, string>>();

  constructor(private readonly options: GatewayOptions) {
    this.instructionsHome = globalInstructionsHome(options.codexHome);
    this.logger = (options.logger ?? nullLogger).child({ component: 'operations' });
    this.store = options.store;
    this.turnUsage = new TurnUsageStore(this.store.database);
    this.questionTracking = new QuestionTrackingStore(
      this.store.database,
      this.logger.child({ component: 'question_tracking' }),
    );
    this.projects = options.projects;
    this.workspaces = new WorkspaceRegistry(
      this.store.database,
      this.projects,
      options.workspacesRoot,
    );
    this.projectClones = new ProjectClones(
      (input) => {
        this.workspaces.assertProjectDirectory(input.path);
        const project = this.projects.add(input);
        this.events.publishProjects(this.projects.list());
        return project;
      },
      (path) => this.projects.list().some((project) => project.canonicalRoot === path),
      this.logger.child({ component: 'clones' }),
      new BackgroundTasks(this.store.database, 'git-clone'),
    );
    this.codex = options.codex;
    this.shell = new ShellService(this.codex);
    this.events = new EventHub(options.limits?.eventBytes);
    this.projection = new Projection(options.limits?.itemBytes);
    this.capacityRetries = new CapacityRetries(
      (job) => this.dispatchCapacityRetry(job),
      (id) => this.publishThread(id),
      this.logger.child({ component: 'capacity_retry' }),
    );
    this.currentEpoch = this.codex.epoch;
    this.store.recover();
    this.loops = new SessionLoopStore(this.store.database);
    this.loops.skipMissed(Date.now());
    this.removeListener = this.codex.onEvent((event) => this.consume(event));
  }

  readGlobalInstructions() {
    return readGlobalInstructions(this.instructionsHome);
  }

  async saveGlobalInstructions(input: SaveGlobalInstructions) {
    if (!this.accepting) throw new AppError('GATEWAY_STOPPING', 'Gateway is stopping', 503);
    if (this.isInMaintenance()) throw this.maintenanceError();
    const pending = saveGlobalInstructions(
      this.instructionsHome,
      input,
      this.logger.child({ component: 'global_instructions' }),
    );
    this.instructionWrites.add(pending);
    try {
      return await pending;
    } finally {
      this.instructionWrites.delete(pending);
    }
  }

  listProjects() {
    return this.projects.list();
  }

  previewContext(threadId: string, cwd: string) {
    try {
      if (!this.codex.ready) return;
      const link = this.store.getThreadLink(threadId);
      if (!link || link.managedEpoch !== this.codex.epoch) return;
      // Windows 8.3 aliases must use the same physical form as the kernel
      // directory handle. Keep persisted project/session paths unchanged.
      const physical = process.platform === 'win32' ? realpathSync.native : realpathSync;
      const canonical = physical(cwd);
      const linked = process.platform === 'win32' ? physical(link.cwd) : link.cwd;
      if (!containsPath(linked, canonical)) return;
      const ownership = this.workspaces.assertOwnership(
        link.projectId,
        process.platform === 'win32' || link.projectId === null ? link.cwd : cwd,
        threadId,
      );
      const canonicalCwd =
        process.platform === 'win32' || link.projectId === null ? canonical : ownership.cwd;
      if (!containsPath(physical(ownership.cwd), canonicalCwd)) return;
      if (!containsPath(linked, canonicalCwd)) return;
      if (link.projectId === null) return { projectId: null, projectName: link.cwd, canonicalCwd };
      const project = this.projects.get(link.projectId);
      return { projectId: project.id, projectName: project.name, canonicalCwd };
    } catch {
      return;
    }
  }

  async getProjectGithubRepository(projectId: string) {
    const project = this.projects.get(projectId);
    const url = await readGithubRepository(project.canonicalRoot);
    this.projects.get(projectId);
    return { url };
  }

  async getProjectDiff(projectId: string) {
    const project = this.projects.get(projectId);
    const result = await readWorkspaceDiff(
      project.canonicalRoot,
      this.workspaces.allocations().map((row) => row.canonicalRoot),
    );
    this.projects.get(projectId);
    return result;
  }

  async getThreadDiff(threadId: string) {
    let link = this.store.getThreadLink(threadId);
    if (!link) {
      this.normalize(await this.codex.readThreadMetadata(threadId));
      link = this.store.getThreadLink(threadId)!;
    }
    const { cwd } = this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    const result = await readWorkspaceDiff(
      cwd,
      this.workspaces
        .allocations()
        .filter((row) => row.threadId !== threadId)
        .map((row) => row.canonicalRoot),
    );
    this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    return result;
  }

  async getThreadGithubRepository(threadId: string) {
    // Use the saved, authorized cwd, including archived and unassigned conversations.
    let link = this.store.getThreadLink(threadId);
    if (!link) {
      this.normalize(await this.codex.readThreadMetadata(threadId));
      link = this.store.getThreadLink(threadId)!;
    }
    const { cwd } = this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    const url = await readGithubRepository(cwd);
    this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    return { url };
  }
  startShell(projectId: string, input: StartShellInput) {
    return this.perform('shell.start', projectId, input, async () => {
      this.ensureCompatibilityConfirmed();
      const project = this.projects.get(projectId);
      this.store.dispatch(input.clientOperationId);
      return { result: { shellCommand: this.shell.start(project, input) } };
    });
  }
  interruptShell(id: string, input: OperationInput) {
    return this.perform('shell.interrupt', id, input, async () => {
      this.store.dispatch(input.clientOperationId);
      await this.shell.interrupt(id);
      return { result: { interrupted: true } };
    });
  }
  isInMaintenance() {
    return this.maintenance;
  }
  setMaintenance(value: boolean, reason: 'update' | 'backup' | 'restart' = 'update') {
    if (!value && this.maintenance && this.maintenanceReason !== reason) return;
    this.maintenance = value;
    this.maintenanceReason = reason;
  }
  maintenanceError() {
    if (this.maintenanceReason === 'restart')
      return new AppError('RESTART_MAINTENANCE', 'Covro is restarting', 503);
    return this.maintenanceReason === 'backup'
      ? new AppError('BACKUP_MAINTENANCE', '正在备份，请完成后重试。', 503)
      : new AppError('UPDATE_MAINTENANCE', '正在升级，请等待服务重新连接', 503);
  }
  async trackHttpMutation(work: () => Promise<void>) {
    if (this.maintenance && this.maintenanceReason === 'restart') throw this.maintenanceError();
    this.httpMutations++;
    try {
      await work();
    } finally {
      this.httpMutations--;
    }
  }
  private prepareMaintenance(kind: 'update' | 'backup' | 'restart', closeAdmission: boolean) {
    const blockers = new Set<RestartBlocker>();
    let reason: string | undefined;
    const block = (activity: RestartBlocker, detail: string) => {
      blockers.add(activity);
      reason ??= detail;
    };
    // Queued retries from a loop yield to restarts and updates. An already dispatched turn
    // still participates in the normal activity/operation checks below.
    if (
      this.capacityRetries.active((job) => kind === 'backup' || !this.scheduledCapacityRetry(job))
    )
      block('retry', '等待模型容量重试结束或取消');
    if (this.projectClones.hasActive) block('clone', '等待项目克隆完成或取消');
    if (this.shell.active()) block('shell', '等待 Shell 命令结束');
    if (
      this.instructionWrites.size ||
      this.defaultWrites.size ||
      this.inFlightOperations.size ||
      this.resumes.size ||
      this.pendingThreadCreations.size
    )
      block('operation', '等待正在提交或恢复的操作完成');

    const markers = this.store.activeMarkers();
    const unconfirmed = '等待任务结束，并核对结果尚未确认的操作';
    if (markers.length) reason ??= unconfirmed;
    if (this.store.unresolvedOperations().length) block('operation', unconfirmed);

    const interactive = '等待执行中的任务、审批或输入结束';
    const activeThreads = new Set<string>();
    for (const thread of this.projection.values()) {
      if (!thread.managed || !isActive(thread.status)) continue;
      activeThreads.add(thread.id);
      block(
        thread.status === 'waitingApproval'
          ? 'approval'
          : thread.status === 'waitingInput'
            ? 'input'
            : 'running',
        interactive,
      );
    }
    for (const action of this.projection.actions.values()) {
      if (action.status !== 'pending' && action.status !== 'responding') continue;
      const input = action.kind === 'questions' || action.kind === 'elicitation';
      block(input ? 'input' : 'approval', interactive);
      if (action.threadId) activeThreads.add(action.threadId);
    }
    // A durable marker with no active projection needs reconciliation before shutdown.
    if (markers.some((entry) => !activeThreads.has(entry.threadId)))
      block('operation', unconfirmed);

    const restarting = kind === 'restart';
    if (
      (this.maintenance && (restarting || this.maintenanceReason !== kind)) ||
      (restarting && !this.accepting)
    )
      blockers.add('maintenance');
    if (restarting && this.httpMutations) blockers.add('operation');
    // The final idle check and gate share one event-loop boundary with write admission.
    if (closeAdmission && !blockers.size) this.setMaintenance(true, kind);
    return { blockers, reason: blockers.has('maintenance') ? '等待当前维护操作结束' : reason };
  }
  restartBlockers(closeAdmission = false): RestartBlocker[] {
    return [...this.prepareMaintenance('restart', closeAdmission).blockers];
  }
  async nativeRestartBlockers(): Promise<RestartBlocker[]> {
    const blockers: RestartBlocker[] = [];
    for (const status of (await this.codex.loadedThreadActivity?.()) ?? []) {
      if (status === 'running') blockers.push('running');
      if (status === 'waitingApproval') blockers.push('approval');
      if (status === 'waitingInput') blockers.push('input');
    }
    return blockers;
  }
  requestRestart(input: RestartRequest, start: () => Promise<{ restartId: string }>) {
    return this.perform('service.restart', 'system', input, async () => {
      this.store.dispatch(input.clientOperationId);
      return { result: await start() };
    });
  }
  prepareUpdate(
    reason: 'update' | 'backup' = 'update',
    closeAdmission = true,
  ): { ready: boolean; reason?: string } {
    const activity = this.prepareMaintenance(reason, closeAdmission);
    return activity.blockers.size ? { ready: false, reason: activity.reason } : { ready: true };
  }
  addProject(input: CreateProjectInput) {
    this.workspaces.assertProjectDirectory(input.path);
    this.projectClones.assertIdlePath(input.path);
    const project = this.projects.add(input);
    this.events.publishProjects(this.projects.list());
    return project;
  }
  cloneProject(input: CloneProjectInput, resolvePath = (path: string) => path) {
    if (this.maintenance || !this.accepting)
      throw new AppError('GATEWAY_STOPPING', '服务正在升级或停止，请稍后重试', 503);
    return this.projectClones.start(input, (path) => {
      const resolved = resolvePath(path);
      this.workspaces.assertProjectDirectory(resolved);
      return resolved;
    });
  }
  registerProjectClone(id: string) {
    if (this.maintenance || !this.accepting) throw this.maintenanceError();
    return this.projectClones.retryRegistration(id);
  }
  renameProject(projectId: string, input: RenameProjectInput) {
    const project = this.projects.rename(projectId, input);
    this.events.publishProjects(this.projects.list());
    return project;
  }
  reorderProjects(input: ReorderProjectsInput) {
    const projects = this.projects.reorder(input);
    this.events.publishProjects(projects);
    return { data: projects };
  }
  removeProject(projectId: string): { removed: true } {
    // A missing directory must still be removable. Do not call get(), which requires it.
    const project = this.projects.describe(projectId);
    const pending = this.store.pendingProjectOperations(projectId)[0];
    const marker = this.store.activeMarkers().find((entry) => {
      const link = this.store.getThreadLink(entry.threadId);
      // Different projects can share a checkout; only an unlinked legacy marker
      // needs the conservative workspace fallback to avoid losing its controls.
      return link ? link.projectId === projectId : entry.workspaceKey === project.workspaceKey;
    });
    const active = this.projection
      .values()
      .find(
        (thread) =>
          thread.projectId === projectId &&
          (isActive(thread.status) ||
            this.capacityRetries.pending(thread.id) ||
            thread.actions.some((action) => ['pending', 'responding'].includes(action.status))),
      );
    if (pending || marker || active || this.shell.active(projectId))
      throw new AppError(
        'PROJECT_BUSY',
        '项目仍有活动任务或结果待核对的操作；请先结束任务并核对旧操作',
        409,
        {
          projectId,
          ...(pending || marker
            ? { operationId: pending?.clientOperationId ?? marker?.operationId }
            : {}),
          ...(marker || active ? { threadId: marker?.threadId ?? active?.id } : {}),
        },
      );
    // Synchronous check + tombstone prevents a task from dispatching between them.
    this.projects.remove(projectId);
    this.events.publishProjects(this.projects.list());
    return { removed: true };
  }
  getSystem(): SystemInfo {
    const diagnostics = this.codex.diagnostics();
    return {
      ...diagnostics,
      compatibilityConfirmation: this.compatibilityConfirmation(diagnostics),
      authMode: this.options.authMode ?? 'local',
      demo: this.options.demo ?? false,
    };
  }

  async refreshAccountUsage() {
    return (
      this.codex.refreshAccountUsage?.() ?? {
        scope: this.codex.epoch,
        status: 'unsupported' as const,
        refreshing: false,
        updatedAt: null,
        groups: [],
        ordinaryUsageAllowed: null,
        resetCreditsAvailable: null,
      }
    );
  }
  subscribeRuntime(listener: (message: ServerMessage) => void): () => void {
    return this.events.subscribeRuntime(listener);
  }
  subscribeOverview(listener: (message: ServerMessage) => void): () => void {
    return this.events.subscribeOverview(listener);
  }

  async confirmCompatibility(input: ConfirmCompatibilityInput): Promise<Operation> {
    return this.perform('system.compatibility.confirm', 'system', input, async () => {
      const diagnostics = this.codex.diagnostics();
      this.ensureCompatibilityAvailable(diagnostics);
      if (
        input.confirm !== true ||
        input.codexEpoch !== diagnostics.codexEpoch ||
        input.codexVersion !== diagnostics.codexVersion ||
        input.verifiedVersion !== diagnostics.verifiedVersion
      )
        throw new AppError(
          'COMPATIBILITY_CHANGED',
          'Codex 运行版本或验证基线已变化，请刷新后重新确认',
          409,
        );
      this.store.dispatch(input.clientOperationId);
      const fingerprint = this.compatibilityFingerprint(diagnostics);
      return {
        result: {
          codexEpoch: diagnostics.codexEpoch,
          codexVersion: diagnostics.codexVersion,
          verifiedVersion: diagnostics.verifiedVersion,
          compatibilityConfirmation:
            diagnostics.compatibility === 'unverified' ? 'confirmed' : 'not-required',
        },
        onAcknowledged: () => {
          const current = this.codex.diagnostics();
          if (
            this.codex.ready &&
            current.ready &&
            current.compatibility === 'unverified' &&
            this.compatibilityFingerprint(current) === fingerprint
          )
            this.confirmedCompatibility = fingerprint;
          this.events.publish('runtime', this.getSystem());
        },
      };
    });
  }

  private referenceScope(cwd: string, threadId?: string, draftId?: string): ReferenceScope {
    return {
      cwd,
      excluded: [
        ...this.projects.referenceRoots().filter((root) => root !== cwd && containsPath(cwd, root)),
        ...this.workspaces
          .allocations()
          .filter((row) => !(threadId && row.threadId === threadId) && row.operationId !== draftId)
          .map((row) => row.canonicalRoot),
      ],
    };
  }

  async searchFiles(input: FileSearchQuery, signal: AbortSignal): Promise<FileSearchResult> {
    this.ensureReady();
    if (!this.codex.searchFiles)
      throw new AppError('METHOD_UNAVAILABLE', 'Codex does not support fuzzyFileSearch', 409);
    const thread = input.threadId ? await this.loadThread(input.threadId) : undefined;
    if (thread && thread.projectId !== input.projectId)
      throw new AppError('PROJECT_OWNERSHIP', 'Session belongs to another workspace', 403);
    const resolveCwd = () =>
      thread
        ? this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id).cwd
        : input.projectId === null
          ? this.workspaces.draft(input.draftId!).cwd
          : this.projects.get(input.projectId).canonicalRoot;
    const cwd = resolveCwd();
    if (input.projectId !== null) this.workspaces.assertProjectDirectory(cwd);
    // A draft id authorizes only its allocated unassigned draft, never a project or session.
    const draftId = !thread && input.projectId === null ? input.draftId : undefined;
    const scope = this.referenceScope(cwd, thread?.id, draftId);
    const epoch = this.codex.epoch;
    const timeout = AbortSignal.timeout(5000);
    const cancellation = AbortSignal.any([signal, timeout]);
    try {
      cancellation.throwIfAborted();
      if (!input.query) return { cwd, paths: [], limited: false };
      const result = await withLogContext({ threadId: thread?.id }, () =>
        this.codex.searchFiles!(cwd, input.query, cancellation),
      );
      const paths: string[] = [];
      let unreadable = false;
      for (const file of result.files.slice(0, 50)) {
        cancellation.throwIfAborted();
        if (file.root !== cwd || file.match_type !== 'file') continue;
        const path = process.platform === 'win32' ? file.path.replaceAll('\\', '/') : file.path;
        try {
          await validateReferencePath(path, scope);
          if (!paths.includes(path)) paths.push(path);
        } catch (error) {
          if (error instanceof AppError && error.code === 'FILE_REFERENCE_UNREADABLE')
            unreadable = true;
          else if (!(error instanceof AppError)) throw error;
          // Vanished or unauthorized candidates never reach the browser.
        }
      }
      cancellation.throwIfAborted();
      this.ensureReady();
      if (
        resolveCwd() !== cwd ||
        this.codex.epoch !== epoch ||
        JSON.stringify(this.referenceScope(cwd, thread?.id, draftId)) !== JSON.stringify(scope)
      )
        throw new AppError('FILE_REFERENCE_CHANGED', 'Workspace changed; search again', 409);
      if (unreadable && !paths.length)
        throw new AppError('FILE_REFERENCE_UNREADABLE', 'Matching files cannot be read', 403);
      return { cwd, paths, limited: result.files.length >= 50 };
    } catch (error) {
      if (timeout.aborted)
        throw new AppError('FILE_SEARCH_TIMEOUT', 'File search timed out; narrow the path', 408);
      if (signal.aborted) throw new AppError('FILE_SEARCH_CANCELLED', 'File search cancelled', 499);
      throw error;
    }
  }

  private async fileMessage(thread: ThreadView, text: string, files: FileReference[] = []) {
    if (!files.length) return text;
    const epoch = this.codex.epoch;
    const ownership = this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    const scope = this.referenceScope(ownership.cwd, thread.id);
    const result = await referenceMessage(text, files, scope);
    this.ensureManaged(thread);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    if (
      this.codex.epoch !== epoch ||
      JSON.stringify(this.referenceScope(ownership.cwd, thread.id)) !== JSON.stringify(scope)
    )
      throw new AppError('FILE_REFERENCE_CHANGED', 'Workspace changed; select the file again', 409);
    return result;
  }

  async listSkills(input: import('../shared/skills.js').SkillQuery) {
    this.ensureReady();
    if (!this.codex.listSkills)
      throw new AppError('METHOD_UNAVAILABLE', 'Codex does not support skills/list', 409);
    const thread = input.threadId ? await this.loadThread(input.threadId) : undefined;
    if (thread && thread.projectId !== input.projectId)
      throw new AppError('PROJECT_OWNERSHIP', 'Session belongs to another workspace', 403);
    const resolveCwd = () =>
      thread
        ? this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id).cwd
        : input.projectId === null
          ? this.workspaces.draft(input.draftId!).cwd
          : this.projects.get(input.projectId).canonicalRoot;
    const cwd = resolveCwd();
    if (input.projectId !== null) this.workspaces.assertProjectDirectory(cwd);
    const epoch = this.codex.epoch;
    const catalog = await this.codex.listSkills(cwd, input.forceReload);
    this.ensureReady();
    if (resolveCwd() !== cwd || this.codex.epoch !== epoch || catalog.cwd !== cwd)
      throw new AppError('SKILLS_READ_FAILED', 'Skill workspace changed; refresh and retry', 409);
    return catalog;
  }

  private async validateSkills(
    thread: ThreadView,
    text: string,
    references: SkillReference[] = [],
  ) {
    if (!references.length) return [];
    const catalog = await this.listSkills({
      projectId: thread.projectId,
      threadId: thread.id,
      forceReload: true,
    });
    const unique = new Map<string, SkillReference>();
    for (const reference of references) {
      const skill = catalog.skills.find(
        (entry) => entry.name === reference.name && entry.path === reference.path && entry.enabled,
      );
      if (
        !skill ||
        reference.cwd !== catalog.cwd ||
        catalog.errors.some((error) => error.path === reference.path) ||
        !hasSkillToken(text, reference.name)
      )
        throw new AppError(
          'SKILL_UNAVAILABLE',
          'A selected skill is no longer available in this workspace. Refresh and select it again.',
          409,
        );
      unique.set(JSON.stringify([skill.name, skill.path]), {
        name: skill.name,
        path: skill.path,
        cwd: catalog.cwd,
      });
    }
    return [...unique.values()];
  }

  async readRuntimeSettings(projectId: string | null) {
    const cwd =
      projectId === null
        ? this.workspaces.defaultsDirectory()
        : this.projects.get(projectId).canonicalRoot;
    return this.codex.readRuntimeSettings(cwd);
  }

  async readGlobalDefaults() {
    this.ensureReady();
    if (!this.codex.readGlobalDefaults)
      throw new AppError('PROTOCOL_INCOMPATIBLE', 'Global defaults are not supported', 503);
    return this.codex.readGlobalDefaults();
  }
  async saveGlobalDefaults(input: SaveGlobalDefaultsInput) {
    if (!this.accepting) throw new AppError('CODEX_UNAVAILABLE', '服务正在关闭', 503);
    if (this.maintenance) throw this.maintenanceError();
    this.ensureReady();
    this.ensureCompatibilityConfirmed();
    if (!this.codex.saveGlobalDefaults)
      throw new AppError('PROTOCOL_INCOMPATIBLE', 'Global defaults are not supported', 503);
    const logger = this.logger.child({ ...logContext(), component: 'global_defaults' });
    const started = performance.now();
    // Only an in-flight write holds maintenance. Codex configuration is the durable truth.
    const pending = Promise.resolve().then(() => this.codex.saveGlobalDefaults!(input));
    this.defaultWrites.add(pending);
    try {
      const result = await pending;
      if (!result || !['ok', 'okOverridden'].includes(result.status))
        throw new AppError('PROTOCOL_INCOMPATIBLE', 'Invalid configuration write result', 502);
      logger.info('global_defaults.saved', {
        outcome: result.status,
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      logger.warn('global_defaults.save_failed', {
        ...errorFields(error),
        durationMs: Math.round(performance.now() - started),
      });
      throw this.asAppError(error);
    } finally {
      this.defaultWrites.delete(pending);
    }
  }
  async saveModelDefaults(
    projectId: string | null,
    input: SaveModelDefaultsInput,
  ): Promise<Operation> {
    return this.perform('config.modelDefaults', projectId ?? UNASSIGNED_SCOPE, input, async () => {
      if (projectId !== null) this.projects.get(projectId);
      this.ensureReady();
      this.ensureCompatibilityConfirmed();
      this.store.associateProject(input.clientOperationId, projectId);
      this.store.dispatch(input.clientOperationId);
      return { result: await this.codex.saveModelDefaults(input.settings) };
    });
  }

  async listThreads(
    projectId: string | null,
    cursor?: string,
    archived = false,
  ): Promise<ThreadPage> {
    const project = projectId === null ? undefined : this.projects.get(projectId);
    const directories = project
      ? project.canonicalRoot
      : this.workspaces.allocations().map((row) => row.canonicalRoot);
    const titleReads = new Map(
      this.projection
        .values()
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => [thread.id, this.beginTitleRead(thread.id)]),
    );
    const archiveReads = new Map(
      this.projection
        .values()
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => [thread.id, this.archiveRevisions.get(thread.id) ?? 0]),
    );
    const page =
      Array.isArray(directories) && !directories.length
        ? { data: [], nextCursor: null }
        : await this.codex.listThreads(directories, cursor, archived);
    if (projectId !== null) this.projects.get(projectId);
    const data: ThreadView[] = [];
    for (const thread of page.data) {
      try {
        if (
          projectId === null &&
          thread.source === 'appServer' &&
          page.data.filter((entry) => entry.cwd === thread.cwd).length === 1
        ) {
          const operationId = this.workspaces.recoverCreation(thread.id, thread.cwd);
          if (operationId && !this.inFlightOperations.has(operationId)) {
            const recovered = this.store.confirmWorkspaceCreation(operationId, thread.id);
            this.events.publish('operation', this.operation(recovered));
          }
        }
        const normalized = this.normalize(thread, projectId);
        normalized.hasMessages ??= true;
        const cached = this.projection.get(thread.id);
        if (cached && normalized.hasMessages) cached.hasMessages = true;
        const titleRead = titleReads.get(thread.id);
        if (cached && archiveReads.get(thread.id) === (this.archiveRevisions.get(thread.id) ?? 0))
          this.updateArchiveState(thread.id, Boolean(normalized.archived));
        if (cached && titleRead !== undefined)
          this.updateThreadTitle(thread.id, normalized.title, titleRead);
        data.push(this.threadView(cached ?? normalized));
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          ![
            'PROJECT_OWNERSHIP',
            'PROJECT_UNAVAILABLE',
            'PROJECT_NOT_FOUND',
            'WORKSPACE_UNAVAILABLE',
          ].includes(error.code)
        )
          throw error;
      }
    }
    if (!archived && cursor === undefined) {
      // Started threads may not be indexed upstream yet. Unsent drafts stay out
      // of history, including live summaries and automatic browser restoration.
      // The gateway may restart before Codex indexes a dispatched first turn.
      // Its durable execution marker must remain discoverable on another device.
      const pending = this.store.activeMarkers().flatMap((marker): ThreadView[] => {
        const link = this.store.getThreadLink(marker.threadId);
        if (link?.projectId !== projectId || this.projection.get(marker.threadId)) return [];
        return [
          {
            id: marker.threadId,
            projectId,
            cwd: link.cwd,
            source: link.source,
            title: '提交结果待核对',
            status: 'unknown',
            turns: [],
            actions: [],
            managed: false,
            updatedAt: marker.createdAt,
          },
        ];
      });
      const managed = [...this.projection.values(), ...pending]
        .filter(
          (thread) =>
            (thread.managed || this.store.activeForThread(thread.id)) &&
            thread.projectId === projectId &&
            this.historyVisible(thread),
        )
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 30);
      for (const thread of managed) {
        this.workspaces.assertOwnership(projectId, thread.cwd, thread.id);
        if (!data.some((entry) => entry.id === thread.id)) data.unshift(this.threadView(thread));
      }
    }
    return {
      data: data.filter((thread) => thread.historyVisible && Boolean(thread.archived) === archived),
      nextCursor: page.nextCursor,
    };
  }

  async listThreadSummaries(
    projectId: string | null,
    cursor?: string,
    archived = false,
  ): Promise<ThreadSummaryPage> {
    // The list can race with live updates. Browsers retain updates newer than this boundary.
    const boundary = this.events.cursor();
    const page = await this.listThreads(projectId, cursor, archived);
    return { data: page.data.map(toThreadSummary), nextCursor: page.nextCursor, cursor: boundary };
  }

  async setThreadArchived(threadId: string, input: ArchiveThreadInput): Promise<Operation> {
    return this.perform('thread.archive', threadId, input, async () => {
      const thread = await this.loadThread(threadId);
      this.ensureReady();
      this.ensureCompatibilityConfirmed();
      this.ensureArchiveAvailable(thread, input.clientOperationId);
      this.ensureRenameAvailable(thread);
      this.store.associateProject(input.clientOperationId, thread.projectId);
      this.archiveChanges.add(threadId);
      try {
        // Native archive unloads the session. Read fresh metadata before dispatch and
        // keep start/resume out of this window so an active task cannot slip through.
        const actual = await this.codex.readThreadMetadata(threadId);
        this.workspaces.assertOwnership(thread.projectId, actual.cwd, thread.id);
        const current = this.projection.get(threadId)!;
        if (
          input.archived &&
          (this.resumes.has(threadId) ||
            this.store.activeForThread(threadId) ||
            (current.managed && current.status === 'unknown') ||
            [actual, current].some(
              (entry) =>
                isActive(entry.status) ||
                entry.turns.some((turn) => isActive(turn.status) || turn.status === 'unknown') ||
                entry.actions.some((action) => ['pending', 'responding'].includes(action.status)),
            ))
        )
          throw new AppError('THREAD_BUSY', '任务结束并处理完待办后才能归档会话', 409);
        this.ensureReady();
        this.ensureCompatibilityConfirmed();
        this.store.dispatch(input.clientOperationId);
        if (Boolean(actual.archived) !== input.archived) {
          try {
            if (input.archived) await this.codex.archiveThread(threadId);
            else await this.codex.unarchiveThread(threadId);
          } catch (error) {
            // Archive can unload before failing. Re-read its native state and release
            // stale local ownership even on a definite rejection; never replay the RPC.
            try {
              const refreshed = await this.codex.readThreadMetadata(threadId);
              this.updateArchiveState(threadId, Boolean(refreshed.archived));
            } catch {
              // Preserve the original failure/uncertainty when the read also fails.
            } finally {
              this.releaseThreadOwnership(threadId);
              this.publishThread(threadId);
            }
            throw error;
          }
        }
        this.beginTitleRead(threadId); // Invalidate older list/metadata reads.
        this.updateArchiveState(threadId, input.archived);
        this.publishThread(threadId);
        return {
          result: {
            threadId,
            archived: input.archived,
            summary: toThreadSummary(this.threadView(this.projection.get(threadId)!)),
            cursor: this.events.cursor(),
          },
        };
      } finally {
        this.archiveChanges.delete(threadId);
      }
    });
  }

  async renameThread(threadId: string, input: RenameThreadInput): Promise<Operation> {
    return this.perform('thread.rename', threadId, input, async () => {
      const problem = threadNameError(input.name);
      if (problem) throw new AppError('VALIDATION_ERROR', problem);
      const name = input.name.trim();
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      this.ensureCompatibilityConfirmed();
      this.ensureRenameAvailable(thread, input.clientOperationId);
      this.store.associateProject(input.clientOperationId, thread.projectId);
      this.renameChanges.add(threadId);
      try {
        const epoch = this.codex.epoch;
        this.store.dispatch(input.clientOperationId);
        await this.codex.renameThread(threadId, name);
        if (this.codex.epoch !== epoch || !this.codex.ready)
          throw new Error('重命名已发送，但 Codex 实例已变化，请核对会话名称');
        // Read native metadata after the write; preserve a newer name notification.
        const sequence = this.beginTitleRead(threadId);
        let actual: ThreadView;
        try {
          actual = await this.codex.readThreadMetadata(threadId);
          if (actual.id !== threadId || this.codex.epoch !== epoch || !this.codex.ready)
            throw new Error('会话或 Codex 实例已变化');
          this.workspaces.assertOwnership(thread.projectId, actual.cwd, thread.id);
        } catch (cause) {
          // A definite read failure does not undo the acknowledged native write.
          throw new Error('重命名已发送，但无法确认会话名称，请核对提交', { cause });
        }
        this.updateThreadTitle(threadId, actual.title, sequence);
        if (actual.title !== name || this.projection.get(threadId)?.title !== name)
          throw new Error('重命名已发送，但当前名称与请求不一致，请核对提交');
        return {
          result: {
            threadId,
            name,
            summary: toThreadSummary(this.threadView(this.projection.get(threadId)!)),
            cursor: this.events.cursor(),
          },
        };
      } finally {
        this.renameChanges.delete(threadId);
      }
    });
  }

  private ensureRenameAvailable(thread: ThreadView, operationId?: string): void {
    const pending = this.store
      .pendingProjectOperations(thread.projectId)
      .some(
        (entry) =>
          entry.kind === 'thread.rename' &&
          entry.target === thread.id &&
          entry.clientOperationId !== operationId &&
          entry.state !== 'accepted',
      );
    if (this.renameChanges.has(thread.id) || pending)
      throw new AppError('THREAD_BUSY', '会话重命名正在处理或结果待核对，请先核对提交', 409);
  }

  private ensureArchiveAvailable(thread: ThreadView, operationId?: string): void {
    const pending = this.store
      .pendingProjectOperations(thread.projectId)
      .find(
        (entry) =>
          entry.kind === 'thread.archive' &&
          entry.target === thread.id &&
          entry.clientOperationId !== operationId,
      );
    if (this.archiveChanges.has(thread.id) || pending)
      throw new AppError('THREAD_BUSY', '会话归档操作正在处理或结果待核对，请刷新状态', 409);
  }

  private releaseThreadOwnership(threadId: string): void {
    const link = this.store.getThreadLink(threadId);
    if (link) this.store.linkThread({ ...link, managedEpoch: null });
    const thread = this.projection.get(threadId);
    if (thread) {
      thread.managed = false;
      delete thread.resumeError;
      this.projection.touch(threadId);
    }
  }

  private updateArchiveState(threadId: string, archived: boolean): void {
    const thread = this.projection.get(threadId);
    if (archived) this.loops.archive(threadId);
    if (!thread || Boolean(thread.archived) === archived) return;
    if (archived) this.capacityRetries.clear(threadId);
    thread.archived = archived;
    this.archiveRevisions.set(threadId, (this.archiveRevisions.get(threadId) ?? 0) + 1);
    if (archived) this.releaseThreadOwnership(threadId);
    this.projection.touch(threadId);
    // A notification may precede the RPC receipt. Other tabs must not resume an
    // unarchived thread until this gateway's lifecycle lock has been released.
    if (!this.archiveChanges.has(threadId)) this.publishThread(threadId);
  }

  private async refreshGoal(thread: ThreadView): Promise<void> {
    if (thread.goal !== undefined || !this.codex.ready || !this.codex.getGoal) return;
    try {
      const goal = await this.codex.getGoal(thread.id);
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (thread.goal === undefined) thread.goal = goal;
    } catch {
      /* Unsupported or disabled goals must not block ordinary session reads. */
    }
  }

  async getThreadMetadata(threadId: string): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    if (cached) {
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      if (this.codex.ready) await this.refreshThreadMetadata(threadId);
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      await this.refreshGoal(cached);
      return {
        ...this.threadView(cached, false, false),
        pendingQuestions: undefined,
        turns: [],
        actions: [],
      };
    }
    // Checking a remembered ID must not load history or resume an unsent thread.
    const metadata = this.threadView(this.normalize(await this.codex.readThreadMetadata(threadId)));
    await this.refreshGoal(metadata);
    metadata.historyVisible = this.historyVisible(metadata);
    return { ...metadata, turns: [], actions: [] };
  }

  async getThread(threadId: string): Promise<ThreadView> {
    return this.detailThreadView(await this.openThread(threadId, true));
  }

  private async openThread(threadId: string, waitForExecution: boolean): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    await this.loadThread(threadId, { raw: true, waitForExecution });
    // The snapshot can render while recovery checks a durable reservation. A successful
    // reconciliation is still published through the same replay boundary as live events.
    const marker = this.store.activeForThread(threadId);
    if (marker && !waitForExecution) void this.refreshExecution(marker);
    if (cached && this.codex.ready) await this.refreshThreadMetadata(threadId);
    const thread = this.projection.get(threadId)!;
    // A completed project can be removed while its metadata request is in flight.
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    await this.refreshGoal(thread);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    return thread;
  }

  getThreadAttention(threadId: string) {
    const thread = this.projection.get(threadId);
    if (!thread) return [];
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    return pendingAttention(this.threadView(thread, false, false));
  }

  private scanQuestionHistory(thread: ThreadView, retry = false): void {
    const { id, projectId } = thread;
    const cursor = thread.history?.olderCursor;
    if (!cursor || thread.archived || !this.codex.ready || !this.codex.readThreadPage) return;
    const epoch = this.codex.epoch;
    const previous = this.questionHistories.get(id);
    if (
      previous?.epoch === epoch &&
      previous.cursor === cursor &&
      (previous.status !== 'error' || (!retry && Date.now() < (previous.retryAt ?? 0)))
    )
      return;
    const entry: QuestionHistory = {
      epoch,
      cursor,
      status: 'loading',
      turns: previous?.turns ?? new Map(),
      observed: previous?.observed,
    };
    this.questionHistories.set(id, entry);
    const current = () => this.questionHistories.get(id) === entry && this.codex.epoch === epoch;
    const logger = this.logger.child({
      component: 'question_history',
      ...logContext(),
      threadId: id,
      codexEpoch: epoch,
    });
    const started = Date.now();
    logger.debug('question.history_scan_started');
    void (async () => {
      const pages: { turn: ThreadView['turns'][number]; cursor: string }[][] = [];
      const seen = new Set<string>();
      let next: string | null = cursor;
      while (next && current()) {
        if (seen.has(next) || seen.size >= 1000)
          throw new AppError(
            'QUESTION_HISTORY_INCOMPLETE',
            'Invalid question history pagination',
            409,
          );
        seen.add(next);
        const page = await this.codex.readThreadPage!(id, next, { deferOutput: true });
        if (!current()) return;
        if (page.id !== id || page.historyTruncated || !page.history)
          throw new AppError('QUESTION_HISTORY_INCOMPLETE', 'Incomplete question history', 409);
        this.workspaces.assertOwnership(projectId, page.cwd, id);
        const source = next;
        pages.push(page.turns.map((turn) => ({ turn: questionEvidence(turn), cursor: source })));
        next = page.history.olderCursor;
      }
      if (!current()) return;
      entry.turns = new Map(
        pages
          .reverse()
          .flat()
          .map((source) => [source.turn.id, source]),
      );
      entry.status = 'ready';
      this.publishThread(id);
      logger.debug('question.history_scan_finished', {
        count: seen.size,
        durationMs: Date.now() - started,
        outcome: 'succeeded',
      });
    })().catch((problem: unknown) => {
      if (!current()) return;
      entry.status = 'error';
      entry.retryAt = Date.now() + 30_000;
      logger.warn('question.history_scan_finished', {
        durationMs: Date.now() - started,
        outcome: 'failed',
        ...errorFields(problem),
      });
      this.publishThread(id);
    });
  }

  private questionHistory(threadId: string): QuestionHistory | undefined {
    const history = this.questionHistories.get(threadId);
    return history?.epoch === this.codex.epoch ? history : undefined;
  }

  private questionState(thread: ThreadView) {
    const history = this.questionHistory(thread.id);
    const cursor = thread.history?.olderCursor;
    return pendingQuestionCatalog(
      thread,
      cursor && history && cursor !== history.cursor ? { ...history, status: 'loading' } : history,
    ).state;
  }

  private async questionCatalog(threadId: string) {
    const thread = this.projection.get(threadId) ?? (await this.openThread(threadId, false));
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    this.scanQuestionHistory(thread);
    return {
      thread,
      ...pendingQuestionCatalog(
        this.threadView(thread, false, false),
        this.questionHistory(threadId),
      ),
    };
  }

  async getPendingQuestions(
    threadId: string,
    cursor?: string,
    retry = false,
  ): Promise<PendingQuestionsPage> {
    const { data, state, thread } = await this.questionCatalog(threadId);
    if (retry && !cursor && state.history === 'error') {
      this.scanQuestionHistory(thread, true);
      if (this.questionHistory(threadId)?.status === 'loading') {
        this.publishThread(threadId);
        state.history = 'loading';
      }
    }
    let offset = 0;
    if (cursor !== undefined) {
      const [version, position, extra] = cursor.split('.');
      offset = Number(position);
      if (
        version !== state.version ||
        extra !== undefined ||
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        offset >= data.length
      )
        throw new AppError('QUESTION_LIST_CHANGED', 'The pending questions changed', 409);
    }
    const end = offset + 40;
    return {
      data: data.slice(offset, end),
      nextCursor: end < data.length ? `${state.version}.${end}` : null,
      history: state.history,
    };
  }

  async locateQuestion(
    threadId: string,
    target: {
      kind: string | undefined;
      id: string | undefined;
      turnId?: string;
      questionId: string | undefined;
    },
  ): Promise<QuestionLocation> {
    const find = async () => {
      const catalog = await this.questionCatalog(threadId);
      const row = catalog.data.find(
        (row) =>
          row.id === target.questionId &&
          row.target.kind === target.kind &&
          row.target.id === target.id &&
          row.turnId === target.turnId,
      );
      if (!row) throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
      return { ...catalog, row };
    };
    const epoch = this.codex.epoch;
    const { row, thread } = await find();
    if (row.target.kind === 'action') return {};
    const source = this.questionHistory(threadId)?.turns.get(row.turnId!);
    let turn = thread.turns.find((turn) => turn.id === row.turnId);
    let cursor: string | undefined;
    if (!turn && source) {
      try {
        const page = await this.getThreadHistory(threadId, source.cursor);
        if (page.id === threadId) turn = page.turns.find((turn) => turn.id === row.turnId);
        if (turn) cursor = source.cursor;
      } catch (problem) {
        if (!(problem instanceof AppError && problem.code === 'HISTORY_CURSOR_EXPIRED'))
          throw problem;
      }
      // Some cursors expire or move on append. Resolve the exact native turn in that case.
      if (!turn && this.codex.readThreadTurnItems && this.codex.epoch === epoch) {
        const metadata = this.normalize(await this.codex.readThreadMetadata(threadId));
        if (metadata.id !== threadId || metadata.archived)
          throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
        this.workspaces.assertOwnership(thread.projectId, metadata.cwd, threadId);
        turn = {
          ...source.turn,
          items: await this.codex.readThreadTurnItems(threadId, source.turn.id),
        };
      }
    }
    const { replies } = await find();
    if (this.codex.epoch !== epoch)
      throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
    const item = turn?.items.find((item) => item.id === row.target.id);
    if (
      !turn ||
      turn.threadId !== threadId ||
      !canTrackQuestions(turn.status) ||
      !item?.questions?.some((_, index) => asyncQuestionId(item.id, index) === row.id)
    )
      throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
    return {
      turn,
      cursor,
      turnNumber: row.turnNumber,
      replies: [
        item.id,
        ...item.questions.map((_, index) => asyncQuestionId(item.id, index)),
      ].flatMap((id) => replies.get(id) ?? []),
    };
  }

  async getThreadSnapshot(threadId: string) {
    const thread = await this.openThread(threadId, false);
    // Copy and cursor share one synchronous boundary; later events are replayable.
    return {
      data: this.detailThreadView(thread),
      cursor: this.events.cursor(),
    };
  }

  async getThreadHistory(threadId: string, cursor?: string): Promise<ThreadView> {
    if (!cursor || cursor.length > 8192)
      throw new AppError('VALIDATION_FAILED', 'Missing or invalid history cursor', 400);
    this.ensureReady();
    // Authorize before reading a page, and check ownership again after the await.
    const metadata = this.normalize(await this.codex.readThreadMetadata(threadId));
    this.workspaces.assertOwnership(metadata.projectId, metadata.cwd, metadata.id);
    if (!this.codex.readThreadPage)
      throw new AppError('HISTORY_UNAVAILABLE', '当前 Codex 不支持历史分页', 409);
    const page = this.normalize(
      await this.codex.readThreadPage(threadId, cursor, { deferOutput: true }),
    );
    this.workspaces.assertOwnership(page.projectId, page.cwd, page.id);
    const links = this.retryLinks(threadId);
    for (const turn of page.turns) {
      const root = links.get(turn.id);
      if (root) turn.retryOf = root;
    }
    return { ...this.threadView(page, true, false), pendingQuestions: undefined };
  }

  async getThreadItem(threadId: string, turnId: string, itemId: string): Promise<ItemView> {
    this.ensureReady();
    const epoch = this.codex.epoch;
    const metadata = await this.codex.readThreadMetadata(threadId);
    if (metadata.id !== threadId || this.codex.epoch !== epoch)
      throw new AppError('THREAD_ITEM_NOT_FOUND', '工具输出不可用。', 404);
    const thread = this.normalize(metadata);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, threadId);
    if (thread.historyMode !== 'paginated' || !this.codex.readThreadItem)
      throw new AppError('HISTORY_UNAVAILABLE', '当前 Codex 不支持按条读取历史。', 409);
    const item = await this.codex.readThreadItem(threadId, turnId, itemId);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, threadId);
    if (this.codex.epoch !== epoch)
      throw new AppError('HISTORY_CURSOR_EXPIRED', '读取期间 Codex 已重启，请重新打开会话。', 409);
    if (item.id !== itemId || !['commandExecution', 'mcpToolCall'].includes(item.type))
      throw new AppError('THREAD_ITEM_NOT_FOUND', '工具输出不可用。', 404);
    return this.projection.limit(item);
  }

  async exportThread(threadId: string) {
    this.ensureReady();
    const epoch = this.codex.epoch;
    const revision = this.projection.revision(threadId);
    // getThread may reuse a size-limited live projection. Export must read every persisted page.
    const thread = await this.codex.readThread(threadId);
    const latest = await this.codex.readThreadMetadata(threadId);
    this.ensureReady();
    if (this.codex.epoch !== epoch)
      throw new AppError('EXPORT_RUNTIME_CHANGED', '读取期间 Codex 已重启，请重新导出。', 409);
    if (thread.id !== threadId || latest.id !== threadId || thread.historyTruncated)
      throw new AppError(
        'EXPORT_HISTORY_INCOMPLETE',
        '未能取得完整会话历史，未生成导出文件。',
        409,
      );
    const link = this.store.getThreadLink(threadId);
    // Revalidate ownership after the read; a project may have been removed while it was pending.
    if (link) this.workspaces.assertOwnership(link.projectId, thread.cwd, thread.id);
    else this.workspaces.findOwner(thread.cwd, thread.id);
    return renderThreadExport(thread, {
      executionUncertain: Boolean(this.store.activeForThread(threadId)),
      historyChanged:
        revision !== this.projection.revision(threadId) ||
        thread.updatedAt !== latest.updatedAt ||
        thread.status !== latest.status,
    });
  }

  getThreadImage(threadId: string, path: string | undefined) {
    return this.readThreadFile(threadId, path, readLocalImage);
  }

  getThreadMarkdown(threadId: string, path: string | undefined) {
    return this.readThreadFile(threadId, path, readLocalMarkdown);
  }

  getThreadText(threadId: string, path: string | undefined) {
    return this.readThreadFile(threadId, path, readLocalText);
  }

  getThreadJson(threadId: string, path: string | undefined) {
    return this.readThreadFile(threadId, path, readLocalJson);
  }

  private async readThreadFile<T>(
    threadId: string,
    path: string | undefined,
    read: (path: string | undefined, scope: FileScope) => Promise<T>,
  ): Promise<T> {
    // Persisted ownership also authorizes saved/archived file previews after a
    // gateway restart while Codex is offline. Never accept a cwd from the browser.
    let link = this.store.getThreadLink(threadId);
    if (!link) {
      this.normalize(await this.codex.readThreadMetadata(threadId));
      link = this.store.getThreadLink(threadId)!;
    }
    const ownership = this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    const { cwd } = ownership;
    const file = await read(path, {
      cwd,
      excludedRoots: this.workspaces
        .allocations()
        .filter((row) => row.threadId !== threadId)
        .map((row) => row.canonicalRoot),
      roots: [
        { canonicalRoot: ownership.canonicalRoot, aliases: [ownership.rootPath] },
        ...(link.projectId === null ? [] : this.fileTemporaryRoots),
      ],
    });
    // The project may have been removed or its directory replaced during the read.
    this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
    return file;
  }

  private async loadThread(
    threadId: string,
    options?: { raw: true; waitForExecution: boolean },
  ): Promise<ThreadView> {
    const view = (thread: ThreadView) => (options?.raw ? thread : this.threadView(thread));
    const cached = this.projection.get(threadId);
    if (cached) {
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      const marker = this.store.activeForThread(threadId);
      if (marker && this.codex.ready) {
        if (options?.waitForExecution !== false) await this.refreshExecution(marker);
        return view(cached);
      }
      // Managed ownership does not make an unknown projection authoritative.
      if (
        ((cached.managed || isActive(cached.status)) && cached.status !== 'unknown') ||
        !this.codex.ready
      )
        return view(cached);
    }
    const existing = this.reads.get(threadId);
    if (existing) return view(await existing);
    const revision = this.projection.revision(threadId);
    const loading = (async () => {
      const thread = this.normalize(
        await (this.codex.readThreadPage?.(threadId, undefined, { deferOutput: true }) ??
          this.codex.readThread(threadId)),
      );
      // Managed live projections are never replaced by a history read finishing later.
      const current = this.projection.get(threadId);
      const preserveCurrent =
        current && (cached === undefined || this.projection.revision(threadId) !== revision);
      const result = preserveCurrent ? current : this.projection.thread(thread);
      this.applyRecoveredMarker(result);
      if (!preserveCurrent)
        for (const turn of result.turns)
          if (isTerminal(turn.status)) this.projection.expireTurn(threadId, turn.id);
      if (cached !== undefined && !preserveCurrent) this.publishThread(threadId);
      return result;
    })();
    this.reads.set(threadId, loading);
    try {
      return view(await loading);
    } finally {
      this.reads.delete(threadId);
    }
  }

  async createSession(projectId: string, input: CreateSessionInput): Promise<Operation> {
    const parsed = createSessionSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'VALIDATION_FAILED',
        'A non-blank prompt of at most 100,000 characters and a valid operation ID are required',
        400,
      );
    input = parsed.data;
    return this.perform('session.create', projectId, input, async () => {
      this.projects.get(projectId);
      this.ensureReady();
      this.ensureCompatibilityConfirmed();
      this.store.associateProject(input.clientOperationId, projectId);
      this.store.dispatch(input.clientOperationId);
      const steps = {
        creationOperationId: randomUUID(),
        promptOperationId: randomUUID(),
        stage: 'creating' as const,
      };
      this.store.checkpoint(input.clientOperationId, steps);
      try {
        const created = await this.createThread(projectId, {
          clientOperationId: steps.creationOperationId,
        });
        const result = sessionCreationResult(this.store, steps);
        if (created.status !== 'acknowledged' || !result.threadId)
          throw new Error('Session creation has no confirmed thread receipt');
        await this.startTurn(result.threadId, {
          clientOperationId: steps.promptOperationId,
          text: input.prompt,
        });
        return { result: sessionCreationResult(this.store, steps) };
      } catch (error) {
        if (
          this.store.get(steps.creationOperationId)?.state === 'unknown' ||
          this.store.get(steps.promptOperationId)?.state === 'unknown'
        )
          this.store.fail(
            input.clientOperationId,
            {
              code: 'RESULT_UNKNOWN',
              message:
                'Session creation or initial prompt submission needs reconciliation; do not create another session',
            },
            true,
          );
        throw error;
      }
    });
  }

  async createThread(projectId: string | null, input: CreateThreadInput): Promise<Operation> {
    return this.perform('thread.create', projectId ?? UNASSIGNED_SCOPE, input, async () => {
      this.ensureReady();
      this.ensureCompatibilityConfirmed();
      const cwd =
        projectId === null
          ? this.workspaces.allocate(input.clientOperationId).cwd
          : this.projects.get(projectId).canonicalRoot;
      if (projectId !== null) this.workspaces.assertProjectDirectory(cwd);
      this.store.associateProject(input.clientOperationId, projectId);
      this.store.dispatch(input.clientOperationId);
      this.pendingThreadCreations.set(input.clientOperationId, cwd);
      const epoch = this.codex.epoch;
      const settingsSequence = this.runtimeSettingsSequence;
      const thread = await this.codex.createThread(cwd, input.settings);
      if (this.codex.epoch !== epoch || !this.codex.ready)
        throw new Error('创建请求已发送，但 Codex 实例已变化，请核对历史');
      if (projectId === null) {
        try {
          this.workspaces.bind(input.clientOperationId, thread.id, thread.cwd);
        } catch (cause) {
          throw new Error('创建请求已发送，但返回的工作目录无法确认，请核对历史', { cause });
        }
      }
      const normalized = this.normalize(thread, projectId, true);
      this.projection.thread(
        normalized,
        this.projection.get(thread.id) !== undefined,
        (this.runtimeSettingsUpdates.get(thread.id) ?? 0) > settingsSequence,
      );
      this.publishThread(thread.id);
      return { result: { threadId: thread.id } };
    });
  }

  async resumeThread(threadId: string, input: ResumeThreadInput): Promise<Operation> {
    return this.perform('thread.resume', threadId, input, async () => {
      this.capacityRetries.clear(threadId);
      const thread = await this.loadThread(threadId);
      this.ensureReady();
      this.ensureArchiveAvailable(thread);
      if (thread.archived) throw new AppError('THREAD_ARCHIVED', '请先取消归档后再恢复会话', 409);
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      this.store.associateProject(input.clientOperationId, thread.projectId);
      const link = this.store.getThreadLink(threadId);
      if (link?.managedEpoch === this.codex.epoch) {
        this.ensureCompatibilityConfirmed();
        this.store.dispatch(input.clientOperationId);
        return { result: { threadId } };
      }
      const marker = this.store.activeForThread(threadId);
      if (marker)
        throw new AppError('RESULT_UNKNOWN', '旧执行仍待核对，请先检查历史并核对旧操作', 409, {
          operationId: marker.operationId,
          threadId,
        });
      const ownership = this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      // Multiple tabs may open the same history simultaneously. Acquire its writer once.
      let pending = this.resumes.get(threadId);
      if (!pending) {
        const epoch = this.codex.epoch;
        const revision = this.projection.revision(threadId);
        const settingsSequence = this.runtimeSettingsSequence;
        const current = this.projection.get(threadId)!;
        delete current.resumeError;
        pending = (async () => {
          try {
            const resumed = await this.codex.resumeThread(threadId, ownership.cwd, input.settings, {
              deferOutput: true,
            });
            if (this.codex.epoch !== epoch || !this.codex.ready)
              throw new Error('恢复请求已发送，但 Codex 实例已变化，请核对提交');
            this.projection.thread(
              this.normalize(resumed, thread.projectId, true),
              this.projection.revision(threadId) !== revision,
              (this.runtimeSettingsUpdates.get(threadId) ?? 0) > settingsSequence,
            );
            this.publishThread(threadId);
          } catch (error) {
            if (
              this.codex.epoch === epoch &&
              this.codex.ready &&
              error instanceof AppError &&
              !('uncertain' in error && error.uncertain)
            ) {
              current.resumeError = error.toJSON();
              this.projection.touch(threadId);
              this.publishThread(threadId);
            }
            throw error;
          }
        })();
        this.resumes.set(threadId, pending);
      }
      try {
        await pending;
      } finally {
        if (this.resumes.get(threadId) === pending) this.resumes.delete(threadId);
      }
      return { result: { threadId } };
    });
  }

  async forkThread(threadId: string, input: ForkThreadInput): Promise<Operation> {
    return this.perform('thread.fork', threadId, input, async () => {
      this.ensureReady();
      // Reading through getThread can reconcile recovered execution markers. Forking only
      // reads the source: its ownership, projection and execution remain untouched.
      const source =
        this.projection.get(threadId) ??
        (await (this.codex.readThreadPage?.(threadId) ?? this.codex.readThread(threadId)));
      const link = this.store.getThreadLink(threadId);
      const ownership = link
        ? this.workspaces.assertOwnership(link.projectId, source.cwd, threadId)
        : this.workspaces.findOwner(source.cwd, source.id);
      this.ensureCompatibilityConfirmed();
      const epoch = this.codex.epoch;
      let forkCwd = ownership.cwd;
      if (ownership.projectId === null) {
        forkCwd = this.workspaces.allocate(input.clientOperationId).cwd;
        await cp(ownership.cwd, forkCwd, { recursive: true, verbatimSymlinks: true });
        this.workspaces.assertOwnership(null, source.cwd, source.id);
      }
      this.store.associateProject(input.clientOperationId, ownership.projectId);
      this.store.dispatch(input.clientOperationId);
      this.pendingThreadCreations.set(input.clientOperationId, forkCwd);
      const settingsSequence = this.runtimeSettingsSequence;
      const forked = await this.codex.forkThread(threadId, forkCwd, input.settings, {
        recentOnly: true,
        deferOutput: true,
      });
      if (forked.id === threadId || this.codex.epoch !== epoch || !this.codex.ready)
        throw new Error('分叉请求已发送，但返回的新会话无法确认，请核对历史');
      let normalized: ThreadView;
      try {
        if (ownership.projectId === null)
          this.workspaces.bind(input.clientOperationId, forked.id, forked.cwd);
        normalized = this.normalize(
          { ...forked, forkedFromId: threadId },
          ownership.projectId,
          true,
        );
      } catch (error) {
        // A malformed result does not prove that upstream failed to create the fork.
        throw new Error('分叉请求已发送，但返回的会话目录无法确认，请核对历史', { cause: error });
      }
      this.projection.thread(
        normalized,
        this.projection.get(forked.id) !== undefined,
        (this.runtimeSettingsUpdates.get(forked.id) ?? 0) > settingsSequence,
      );
      this.publishThread(forked.id);
      return { result: { threadId: forked.id, forkedFromId: threadId } };
    });
  }

  async startTurn(threadId: string, input: StartTurnInput): Promise<Operation> {
    this.manualStarts.set(threadId, (this.manualStarts.get(threadId) ?? 0) + 1);
    try {
      return await this.dispatchTurn(threadId, input);
    } finally {
      const remaining = this.manualStarts.get(threadId)! - 1;
      if (remaining) this.manualStarts.set(threadId, remaining);
      else this.manualStarts.delete(threadId);
    }
  }

  private loopWorkspace(threadId: string) {
    const link = this.store.getThreadLink(threadId);
    if (!link) throw new AppError('THREAD_NOT_FOUND', 'Session not found', 404);
    return this.workspaces.assertOwnership(link.projectId, link.cwd, threadId);
  }

  async listSessionLoops(threadId: string) {
    if (!this.store.getThreadLink(threadId)) await this.loadThread(threadId);
    const workspace = this.loopWorkspace(threadId);
    return this.loops.list(threadId, workspace.workspaceKey);
  }

  async createSessionLoop(threadId: string, input: CreateSessionLoop) {
    input = createSessionLoopSchema.parse(input);
    return this.perform('loop.create', threadId, input, async () => {
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      this.ensureCompatibilityConfirmed();
      if (!(thread.hasMessages || thread.turns.some((turn) => isTerminal(turn.status))))
        throw new AppError('LOOP_UNSAVED_THREAD', 'Send a message to save this session first', 409);
      if (parseQuestionReplies(input.prompt))
        throw new AppError('LOOP_INVALID_PROMPT', 'A loop requires a regular prompt', 400);
      const workspace = this.loopWorkspace(threadId);
      const runtime = thread.runtimeSettings;
      const permissionMode = runtime?.permissionMode;
      const hasPermissionOverrides =
        input.settings?.permissionMode !== undefined ||
        input.settings?.approvalPolicy !== undefined ||
        input.settings?.approvalReviewer !== undefined ||
        input.settings?.sandbox !== undefined;
      const settings = this.retrySettings(runtime, {
        ...(runtime?.collaborationMode ? { collaborationMode: runtime.collaborationMode } : {}),
        ...(!hasPermissionOverrides && permissionMode && permissionMode !== 'custom'
          ? { permissionMode }
          : {}),
        ...input.settings,
      });
      const now = Date.now();
      this.store.dispatch(input.clientOperationId, undefined, undefined, (tx) =>
        this.loops.create(tx, {
          id: input.clientOperationId,
          threadId,
          workspaceKey: workspace.workspaceKey,
          settings,
          prompt: input.prompt,
          intervalMs: input.intervalMs,
          status: 'active',
          nextRunAt: now + input.intervalMs,
        }),
      );
      return { result: sessionLoopView(this.loops.get(input.clientOperationId)!) };
    });
  }

  async controlSessionLoop(
    threadId: string,
    loopId: string,
    input: OperationInput & { action: SessionLoopAction; version: number },
  ) {
    return this.perform('loop.control', threadId, { ...input, loopId }, async () => {
      const thread = input.action === 'resume' ? await this.loadThread(threadId) : undefined;
      const { workspaceKey } = this.loopWorkspace(threadId);
      const row = this.loops.get(loopId);
      if (!row || row.threadId !== threadId || row.workspaceKey !== workspaceKey)
        throw new AppError('LOOP_NOT_FOUND', 'Loop not found', 404);
      const now = Date.now();
      const canChange =
        row.version === input.version &&
        (input.action === 'cancel'
          ? row.status === 'active' || row.status === 'paused'
          : input.action === 'pause'
            ? row.status === 'active'
            : row.status === 'paused' && thread?.archived !== true && row.lastResult !== 'unknown');
      if (!canChange)
        throw new AppError('LOOP_CONFLICT', 'The loop has changed or cannot be resumed', 409);
      this.store.dispatch(input.clientOperationId, undefined, undefined, (tx) =>
        this.loops.control(tx, row, input.action, now),
      );
      const retry = this.capacityRetries.current(threadId);
      if (
        input.action !== 'resume' &&
        retry &&
        row.lastOperationId &&
        [retry.operationId, retry.previousOperationId].includes(row.lastOperationId) &&
        this.capacityRetries.pending(threadId) &&
        !this.store.activeForThread(threadId)
      )
        this.capacityRetries.cancel(retry);
      return { result: sessionLoopView(this.loops.get(loopId)!) };
    });
  }

  startLoopScheduler(): void {
    if (this.loopTimer || this.loopSchedulerStopped) return;
    this.loopTimer = setInterval(() => {
      void this.tickSessionLoops().catch((error) =>
        this.logger.warn('loop.scheduler_failed', errorFields(error)),
      );
    }, 1_000);
    this.loopTimer.unref();
  }

  stopLoopScheduler(): void {
    this.loopSchedulerStopped = true;
    if (this.loopTimer) clearInterval(this.loopTimer);
  }

  private loopDispatchDeferred(): boolean {
    return (
      this.loopSchedulerStopped ||
      !this.accepting ||
      this.maintenance ||
      this.options.maintenancePending?.() === true
    );
  }

  private scheduledCapacityRetry(job: CapacityAttempt): SessionLoopRow | undefined {
    return (
      this.loops.byRun(job.operationId) ??
      (job.previousOperationId ? this.loops.byRun(job.previousOperationId) : undefined)
    );
  }

  tickSessionLoops(): Promise<void> {
    this.loopTick ??= this.runSessionLoops().finally(() => {
      this.loopTick = undefined;
    });
    return this.loopTick;
  }

  private async runSessionLoops(): Promise<void> {
    if (this.loopSchedulerStopped || !this.accepting || this.maintenance) return;
    const now = Date.now();
    if (!this.codex.ready || this.codex.diagnostics().authenticated === false) {
      this.loopsOffline = true;
      return;
    }
    if (this.loopsOffline) {
      this.loops.skipMissed(now);
      this.loopsOffline = false;
    }
    // Each session is independent. Within a session, the oldest due loop wins.
    const grouped = new Map<string, { unfinished: SessionLoopRow[]; due?: SessionLoopRow }>();
    for (const row of this.loops.unfinished()) {
      const group = grouped.get(row.threadId) ?? { unfinished: [] };
      group.unfinished.push(row);
      grouped.set(row.threadId, group);
    }
    const dueLoops = this.loops.due(now);
    if (dueLoops.length && !this.loopDispatchDeferred()) {
      for (const row of dueLoops) {
        const group = grouped.get(row.threadId) ?? { unfinished: [] };
        group.due ??= row;
        grouped.set(row.threadId, group);
      }
    }
    await Promise.all(
      [...grouped.values()].map(async ({ unfinished, due }) => {
        for (const row of unfinished) await this.settleLoopRun(row);
        if (due) await this.runDueLoop(due);
      }),
    );
  }

  private async settleLoopRun(row: SessionLoopRow): Promise<void> {
    const operationId = row.lastOperationId;
    if (!operationId) return;
    const retry = this.capacityRetries.current(row.threadId);
    if (
      this.capacityRetries.pending(row.threadId) &&
      (retry?.operationId === operationId || retry?.previousOperationId === operationId)
    )
      return;
    const operation = this.store.get(operationId);
    const active = this.store.activeForThread(row.threadId);
    const marker = active?.operationId === operationId ? active : undefined;
    if (marker?.state === 'active') return;
    let thread: ThreadView;
    try {
      thread = await this.loadThread(row.threadId);
    } catch (error) {
      const code = this.asAppError(error).code;
      if (code === 'THREAD_NOT_FOUND') this.loops.suspend(row, 'deleted');
      else if (
        [
          'PROJECT_NOT_FOUND',
          'PROJECT_UNAVAILABLE',
          'PROJECT_OWNERSHIP',
          'WORKSPACE_UNAVAILABLE',
        ].includes(code)
      )
        this.loops.suspend(row, 'unavailable');
      return;
    }
    const turnId =
      (operation?.result as { turnId?: string } | null)?.turnId ?? marker?.turnId ?? row.lastTurnId;
    const turn = turnId
      ? thread.turns.find((entry) => entry.id === turnId)
      : thread.turns.find((entry) =>
          entry.items.some((item) => item.type === 'userMessage' && item.clientId === operationId),
        );
    if (turn && isTerminal(turn.status)) {
      this.loops.record(row, turn.status as SessionLoopResult, turn.id);
    } else if (operation?.reconciledAt != null) {
      this.loops.record(row, 'reconciled', turnId ?? null);
    } else if (operation?.state === 'failed') {
      this.loops.record(row, 'failed', turnId ?? null);
    } else if (operation?.state === 'unknown' || marker?.state === 'unknown') {
      this.loops.record(row, 'unknown', turnId ?? null);
      this.loops.suspend(row, 'uncertain');
    }
  }

  private recordLoopTurn(operationId: string, status: string, turnId: string): void {
    const row = this.loops.byRun(operationId);
    if (row && !this.capacityRetries.pending(row.threadId))
      this.loops.record(row, status as SessionLoopResult, turnId);
  }

  private assertLoopIdle(thread: ThreadView, row: SessionLoopRow): void {
    if (this.loopDispatchDeferred()) throw new AppError('LOOP_WAITING', 'The service is busy', 409);
    if (
      this.manualStarts.has(thread.id) ||
      this.capacityRetries.pending(thread.id) ||
      this.resumes.has(thread.id) ||
      this.store.activeForThread(thread.id) ||
      isActive(thread.status) ||
      thread.status === 'unknown' ||
      thread.turns.some((turn) => isActive(turn.status) || turn.status === 'unknown') ||
      thread.actions.some((action) => ['pending', 'responding'].includes(action.status))
    )
      throw new AppError('LOOP_WAITING', 'The session is busy', 409);
    if (this.loopWorkspace(thread.id).workspaceKey !== row.workspaceKey)
      throw new AppError('LOOP_WORKSPACE_CHANGED', 'The loop workspace has changed', 409);
  }

  private async runDueLoop(row: SessionLoopRow): Promise<void> {
    if (this.loopDispatchDeferred()) return;
    const current = this.loops.get(row.id);
    if (
      current?.status !== 'active' ||
      current.version !== row.version ||
      ['running', 'unknown'].includes(current.lastResult ?? '')
    )
      return;
    const operationId = randomUUID();
    try {
      const thread = await this.loadThread(row.threadId);
      if (thread.archived) {
        this.loops.archive(thread.id);
        return;
      }
      this.assertLoopIdle(thread, row);
      this.ensureCompatibilityConfirmed();
      if (!thread.managed || this.store.getThreadLink(thread.id)?.managedEpoch !== this.codex.epoch)
        await this.resumeThread(thread.id, {
          clientOperationId: randomUUID(),
          settings: row.settings,
        });
      if (this.loopDispatchDeferred()) return;
      await this.dispatchTurn(
        thread.id,
        {
          clientOperationId: operationId,
          text: row.prompt,
          settings: row.settings,
        },
        undefined,
        undefined,
        row,
      );
    } catch (error) {
      switch (this.asAppError(error).code) {
        case 'THREAD_NOT_FOUND':
          this.loops.suspend(row, 'deleted');
          break;
        case 'THREAD_ARCHIVED':
          this.loops.archive(row.threadId);
          break;
        case 'LOOP_WAITING':
        case 'LOOP_CONFLICT':
        case 'THREAD_BUSY':
        case 'CODEX_UNAVAILABLE':
        case 'COMPATIBILITY_CONFIRMATION_REQUIRED':
        case 'RESTART_MAINTENANCE':
        case 'UPDATE_MAINTENANCE':
        case 'BACKUP_MAINTENANCE':
          break;
        case 'RESULT_UNKNOWN':
          this.loops.suspend(row, 'uncertain');
          break;
        default: {
          const dispatched = this.loops.byRun(operationId);
          if (dispatched) this.loops.record(dispatched, 'failed', null);
          else this.loops.suspend(row, 'unavailable');
        }
      }
    }
  }

  private async dispatchTurn(
    threadId: string,
    input: StartTurnInput,
    retry?: CapacityAttempt,
    expectedTurnId?: string,
    loop?: SessionLoopRow,
  ): Promise<Operation> {
    return this.perform('turn.start', threadId, input, async () => {
      if (
        !loop &&
        !retry &&
        !expectedTurnId &&
        this.capacityRetries.view(threadId)?.status === 'waiting'
      )
        this.capacityRetries.clear(threadId);
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      const ownership = this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (expectedTurnId) {
        const last = thread.turns.at(-1);
        if (
          last?.id !== expectedTurnId ||
          last.status !== 'failed' ||
          !isModelCapacityError(last.error ?? '', last.errorCode)
        )
          throw new AppError('TURN_CONFLICT', '目标容量失败已改变，请刷新后继续', 409);
      }
      if (isActive(this.projection.get(threadId)?.status ?? thread.status))
        throw new AppError('THREAD_BUSY', '会话已有活动任务，请追加要求或中断', 409, { threadId });
      this.ensureCompatibilityConfirmed();
      if (input.taskKind === 'init') await assertProjectInstructionsMissing(ownership.cwd);
      let skills: SkillReference[] = [];
      if (input.skills?.length) {
        skills = await this.validateSkills(thread, input.text, input.skills);
        this.ensureManaged(thread);
        this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
        if (isActive(this.projection.get(threadId)?.status ?? thread.status))
          throw new AppError('THREAD_BUSY', 'Session already has an active task', 409);
      }
      const fileText = input.files?.length
        ? await this.fileMessage(thread, input.text, input.files)
        : input.text;
      if (isActive(this.projection.get(threadId)?.status ?? thread.status))
        throw new AppError('THREAD_BUSY', 'Session already has an active task', 409);
      if (parseQuestionReplies(fileText))
        await this.claimQuestionReplies(threadId, fileText, input.clientOperationId);
      const message = {
        ...input,
        text: input.taskKind === 'init' ? PROJECT_INIT_PROMPT : fileText,
      };
      if (loop) this.assertLoopIdle(this.projection.get(threadId) ?? thread, loop);
      const retryLoop = retry?.previousOperationId
        ? this.loops.byRun(retry.previousOperationId)
        : undefined;
      if (retryLoop && this.loopDispatchDeferred())
        throw new AppError('LOOP_WAITING', 'The service is busy', 409);
      const claimLoop = loop
        ? (tx: AppTransaction) => this.loops.claim(tx, loop, input.clientOperationId, Date.now())
        : retryLoop && retry?.previousOperationId
          ? (tx: AppTransaction) =>
              this.loops.retry(
                tx,
                retryLoop.id,
                retry.previousOperationId!,
                input.clientOperationId,
              )
          : undefined;
      this.store.dispatch(
        input.clientOperationId,
        {
          threadId,
          workspaceKey: ownership.workspaceKey,
          codexEpoch: this.codex.epoch,
        },
        message.text || message.images?.length
          ? {
              threadId,
              item: submittedUserMessage(input.clientOperationId, message),
            }
          : undefined,
        claimLoop,
      );
      if (retry && !this.capacityRetries.owns(retry))
        throw new AppError('TURN_CONFLICT', '容量重试已取消或被替代', 409);
      const candidate =
        retry ??
        this.capacityRetries.begin(
          threadId,
          input.clientOperationId,
          this.retrySettings(thread.runtimeSettings, input.settings),
          this.codex.epoch,
        );
      const retryOf =
        retry?.rootTurnId ??
        (expectedTurnId
          ? (this.retryLinks(threadId).get(expectedTurnId) ?? expectedTurnId)
          : undefined);
      this.turnBaselines.set(input.clientOperationId, new Set(thread.turns.map((turn) => turn.id)));
      // A refresh must discover a dispatched first message even before its turn
      // notification or receipt arrives. A definite failure removes the marker.
      this.publishThread(threadId);
      const revision = this.projection.revision(threadId);
      const turn = await this.codex.startTurn(
        threadId,
        ownership.cwd,
        message.text,
        input.settings,
        input.images,
        skills.length ? skills : undefined,
        input.clientOperationId,
      );
      this.store.attachTurn(input.clientOperationId, turn.id);
      this.turnBaselines.delete(input.clientOperationId);
      this.projection.turn(threadId, turn, this.projection.revision(threadId) !== revision);
      this.capacityRetries.observe({ type: 'turn', threadId, turn }, input.clientOperationId);
      if (retryOf) this.retryLinks(threadId).set(turn.id, retryOf);
      if (candidate.cancelled && retry) await this.interruptCancelledCapacity(candidate, turn.id);
      const projectedTurn = this.projection
        .get(threadId)
        ?.turns.find((entry) => entry.id === turn.id);
      if (projectedTurn && isTerminal(projectedTurn.status)) {
        this.store.finishTurn(threadId, turn.id, this.codex.epoch);
        this.recordLoopTurn(input.clientOperationId, projectedTurn.status, turn.id);
      }
      this.publishThread(threadId);
      return {
        result: { threadId, turnId: turn.id, ...(retryOf ? { retryOf } : {}) },
        turnId: turn.id,
      };
    });
  }

  private retrySettings(runtime: ThreadView['runtimeSettings'], input: Settings = {}): Settings {
    return {
      ...(runtime?.model ? { model: runtime.model } : {}),
      ...(runtime?.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
      ...(runtime?.serviceTier === 'fast' || runtime?.serviceTier === null
        ? { serviceTier: runtime.serviceTier }
        : {}),
      ...input,
    };
  }

  private async dispatchCapacityRetry(job: CapacityAttempt): Promise<void> {
    if (
      !this.capacityRetries.owns(job) ||
      !this.accepting ||
      this.maintenance ||
      !this.codex.ready ||
      this.codex.epoch !== job.epoch
    )
      throw new AppError('TURN_CONFLICT', '容量重试的运行环境已改变', 409);
    const thread = this.projection.get(job.threadId);
    const last = thread?.turns.at(-1);
    if (
      !thread ||
      !last ||
      last.id !== job.turnId ||
      last.status !== 'failed' ||
      this.store.activeForThread(job.threadId) ||
      !job.previousOperationId ||
      this.store.get(job.previousOperationId)?.state !== 'acknowledged' ||
      this.inFlightOperations.has(job.previousOperationId)
    )
      throw new AppError('TURN_CONFLICT', '原任务状态已改变，请检查后继续', 409);
    await this.dispatchTurn(
      job.threadId,
      {
        clientOperationId: job.operationId,
        text: '',
        settings: job.settings,
      },
      job,
    );
  }

  async cancelCapacityRetry(threadId: string, input: InterruptInput): Promise<Operation> {
    return this.perform('turn.retry.cancel', threadId, input, async () => {
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      const job = this.capacityRetries.current(threadId);
      if (!job?.view || job.rootTurnId !== input.expectedTurnId)
        throw new AppError('TURN_CONFLICT', '容量重试已结束或被替代', 409);
      this.store.dispatch(input.clientOperationId);
      this.capacityRetries.cancel(job);
      if (job.attempt > 0 && job.turnId) await this.interruptCancelledCapacity(job, job.turnId);
      return { result: { threadId, cancelled: true } };
    });
  }

  private async interruptCancelledCapacity(job: CapacityAttempt, turnId: string): Promise<void> {
    const turn = this.projection.get(job.threadId)?.turns.find((entry) => entry.id === turnId);
    if (
      !job.cancelled ||
      job.interruptSent ||
      !turn ||
      !isActive(turn.status) ||
      this.codex.epoch !== job.epoch ||
      !this.codex.ready
    )
      return;
    job.interruptSent = true;
    await this.codex.interruptTurn(job.threadId, turnId);
  }

  async retryTurn(threadId: string, input: RetryTurnInput): Promise<Operation> {
    return this.dispatchTurn(threadId, { ...input, text: '' }, undefined, input.expectedTurnId);
  }

  async getGoal(threadId: string) {
    const thread = await this.loadThread(threadId);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    this.ensureReady();
    if (!this.codex.getGoal) throw new AppError('GOAL_UNAVAILABLE', '当前 Codex 不支持目标', 409);
    const goal = await this.codex.getGoal(threadId);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    const current = this.projection.get(threadId);
    if (current) {
      current.goal = goal;
      this.projection.touch(threadId);
      this.publishThread(threadId);
    }
    return { goal, version: requestDigest(goal) };
  }
  async mutateGoal(
    threadId: string,
    input: OperationInput & GoalMutation & { confirm: true; expectedVersion: string },
  ): Promise<Operation> {
    return this.perform('goal.update', threadId, input, async () => {
      if (this.goalWrites.has(threadId))
        throw new AppError('GOAL_BUSY', '目标更新正在进行，请等待回执', 409);
      this.goalWrites.add(threadId);
      try {
        const thread = await this.loadThread(threadId);
        this.ensureManaged(thread);
        this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
        const stopping =
          input.action === 'clear' ||
          (input.action === 'set' &&
            input.status !== 'active' &&
            input.status !== undefined &&
            input.objective === undefined &&
            input.tokenBudget === undefined);
        if (
          !stopping &&
          (thread.status === 'unknown' ||
            isActive(thread.status) ||
            thread.turns.some((turn) => isActive(turn.status)) ||
            this.store.activeForThread(threadId))
        )
          throw new AppError('THREAD_BUSY', '请等待当前任务结束并核对状态后再修改或恢复目标', 409);
        this.ensureCompatibilityConfirmed();
        if (!this.codex.getGoal || !this.codex.mutateGoal)
          throw new AppError('GOAL_UNAVAILABLE', '当前 Codex 不支持目标', 409);
        const before = await this.getGoal(threadId);
        if (before.version !== input.expectedVersion)
          throw new AppError('GOAL_CONFLICT', '目标已发生变化，请重新读取后操作', 409);
        // No marker until real turn evidence: a goal mutation may start an idle turn,
        // inject into an existing turn, or remain limited without starting any turn.
        this.store.dispatch(input.clientOperationId);
        const mutation: GoalMutation =
          input.action === 'clear'
            ? { action: 'clear' }
            : {
                action: 'set',
                ...(input.objective === undefined ? {} : { objective: input.objective }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
              };
        const previousGoal = this.projection.get(threadId)?.goal;
        const goal = await this.codex.mutateGoal(threadId, mutation);
        const current = this.projection.get(threadId);
        if (current && current.goal === previousGoal) {
          current.goal = goal;
          this.projection.touch(threadId);
          this.publishThread(threadId);
        }
        return { result: { goal } };
      } finally {
        this.goalWrites.delete(threadId);
      }
    });
  }

  async recapThread(
    threadId: string,
    input: OperationInput & { language: string },
  ): Promise<Operation> {
    return this.perform('thread.recap', threadId, input, async () => {
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (
        thread.status === 'unknown' ||
        isActive(thread.status) ||
        thread.turns.some((turn) => isActive(turn.status))
      )
        throw new AppError('THREAD_BUSY', '请等待任务结束并核对状态后再生成摘要', 409);
      this.ensureCompatibilityConfirmed();
      if (!this.codex.recapThread)
        throw new AppError('METHOD_UNAVAILABLE', 'Codex 不支持会话摘要', 409);
      const history = await (this.codex.readThreadPage?.(threadId) ??
        this.codex.readThread(threadId));
      this.workspaces.assertOwnership(thread.projectId, history.cwd, history.id);
      const { prompt, partial } = recapInput(history, input.language);
      if (
        !history.turns.some((turn) =>
          turn.items.some(
            (item) =>
              (item.type === 'userMessage' || item.type === 'agentMessage') && item.text?.trim(),
          ),
        )
      )
        throw new AppError('EMPTY_THREAD', '当前会话没有可生成摘要的消息', 409);
      this.store.dispatch(input.clientOperationId);
      const summary = await this.codex.recapThread(threadId, prompt);
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      return { result: { summary, partial, readAt: Date.now() } };
    });
  }
  async getGuardianDenials(threadId: string) {
    const thread = await this.loadThread(threadId);
    this.ensureManaged(thread);
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    if (!this.codex.listGuardianDenials)
      throw new AppError('METHOD_UNAVAILABLE', 'Codex 不支持拒绝记录读取', 409);
    return { data: this.codex.listGuardianDenials(threadId) };
  }
  async approveGuardianDenial(
    threadId: string,
    input: OperationInput & { denialId: string; confirm: true },
  ): Promise<Operation> {
    return this.perform('guardian.approve', threadId, input, async () => {
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (
        thread.status === 'unknown' ||
        isActive(thread.status) ||
        thread.turns.some((turn) => isActive(turn.status))
      )
        throw new AppError('THREAD_BUSY', '请等待当前任务结束并确认状态后再授权重试', 409);
      this.ensureCompatibilityConfirmed();
      if (
        !this.codex.approveGuardianDenial ||
        !this.codex.listGuardianDenials?.(threadId).some((entry) => entry.id === input.denialId)
      )
        throw new AppError('DENIAL_EXPIRED', '拒绝记录已失效，请重新查看当前会话', 409);
      this.store.dispatch(input.clientOperationId);
      await this.codex.approveGuardianDenial(threadId, input.denialId);
      this.publishThread(threadId);
      return { result: { threadId } };
    });
  }

  async compactThread(threadId: string, input: OperationInput): Promise<Operation> {
    return this.perform('thread.compact', threadId, input, async () => {
      this.capacityRetries.clear(threadId);
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      const ownership = this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
        throw new AppError('THREAD_BUSY', '请等待当前任务结束后再压缩上下文', 409);
      if (!thread.turns.length)
        throw new AppError('EMPTY_THREAD', '当前会话为空，无需压缩上下文', 409);
      if (thread.status === 'unknown')
        throw new AppError('RESULT_UNKNOWN', '请先核对当前会话的执行状态', 409);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId, {
        threadId,
        workspaceKey: ownership.workspaceKey,
        codexEpoch: this.codex.epoch,
      });
      this.turnBaselines.set(input.clientOperationId, new Set(thread.turns.map((turn) => turn.id)));
      this.publishThread(threadId);
      await this.codex.compactThread(threadId);
      // No turn ID in this RPC's receipt. consume() binds the new turn and only
      // real terminal evidence releases this durable execution reservation.
      this.publishThread(threadId);
      return { result: { threadId } };
    });
  }

  async startReview(threadId: string, input: StartReviewInput): Promise<Operation> {
    return this.perform('review.start', threadId, input, async () => {
      this.capacityRetries.clear(threadId);
      const thread = await this.loadThread(threadId);
      this.ensureManaged(thread);
      const ownership = this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
      if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
        throw new AppError('THREAD_BUSY', '会话已有活动任务，结束后才能开始代码审查', 409, {
          threadId,
        });
      if (thread.status === 'unknown')
        throw new AppError('RESULT_UNKNOWN', '会话状态尚未确认，请先核对提交', 409, { threadId });
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId, {
        threadId,
        workspaceKey: ownership.workspaceKey,
        codexEpoch: this.codex.epoch,
      });
      const revision = this.projection.revision(threadId);
      this.turnBaselines.set(input.clientOperationId, new Set(thread.turns.map((turn) => turn.id)));
      const turn = await this.codex.startReview(threadId, input.target);
      this.store.attachTurn(input.clientOperationId, turn.id);
      this.turnBaselines.delete(input.clientOperationId);
      // A completion or approval can arrive before review/start returns its initial turn.
      this.projection.turn(threadId, turn, this.projection.revision(threadId) !== revision);
      const projectedTurn = this.projection
        .get(threadId)
        ?.turns.find((entry) => entry.id === turn.id);
      if (projectedTurn && isTerminal(projectedTurn.status))
        this.store.finishTurn(threadId, turn.id, this.codex.epoch);
      this.publishThread(threadId);
      return { result: { threadId, turnId: turn.id }, turnId: turn.id };
    });
  }

  async steer(threadId: string, input: SteerInput): Promise<Operation> {
    return this.perform('turn.steer', threadId, input, async () => {
      await this.requireActiveTurn(threadId, input.expectedTurnId);
      if (input.skills?.length)
        throw new AppError(
          'SKILL_STEER_UNSUPPORTED',
          'Codex 0.164.0 does not reliably inject skill instructions into an active turn. Wait for the current task to finish, then send the preserved draft.',
          409,
        );
      this.ensureCompatibilityConfirmed();
      let message = input.text;
      if (input.files?.length) {
        const thread = await this.loadThread(threadId);
        message = await this.fileMessage(thread, input.text, input.files);
        await this.requireActiveTurn(threadId, input.expectedTurnId);
      }
      if (parseQuestionReplies(message))
        await this.claimQuestionReplies(threadId, message, input.clientOperationId);
      this.store.dispatch(input.clientOperationId, undefined, {
        threadId,
        turnId: input.expectedTurnId,
        item: submittedUserMessage(input.clientOperationId, { ...input, text: message }),
      });
      this.publishThread(threadId);
      const result = await this.codex.steerTurn(
        threadId,
        input.expectedTurnId,
        message,
        input.images,
        input.clientOperationId,
      );
      return { result: { threadId, turnId: result.turnId }, turnId: result.turnId };
    });
  }

  async updateLiveSettings(threadId: string, input: UpdateLiveSettingsInput): Promise<Operation> {
    const previous = this.liveSettingsWrites.get(threadId) ?? Promise.resolve();
    const writing = previous
      .catch(() => {})
      .then(() =>
        this.perform('turn.settings', threadId, input, async () => {
          await this.requireActiveTurn(threadId, input.expectedTurnId);
          this.ensureCompatibilityConfirmed();
          const thread = this.projection.get(threadId)!;
          const ownership = this.workspaces.assertOwnership(
            thread.projectId,
            thread.cwd,
            thread.id,
          );
          if (!this.codex.updateLiveSettings)
            throw new AppError('PROTOCOL_INCOMPATIBLE', 'Codex does not support live settings');
          const epoch = this.codex.epoch;
          this.store.dispatch(input.clientOperationId);
          const patch = await this.codex.updateLiveSettings(
            threadId,
            ownership.cwd,
            input.expectedTurnId,
            input.settings,
          );
          const current = this.projection.get(threadId);
          // A late receipt cannot label a replacement task or another runtime as updated.
          if (
            this.codex.epoch === epoch &&
            current?.turns.at(-1)?.id === input.expectedTurnId &&
            isActive(current.turns.at(-1)!.status) &&
            Object.keys(patch).length
          ) {
            current.liveSettings = {
              ...(current.liveSettings?.turnId === input.expectedTurnId
                ? current.liveSettings
                : {}),
              turnId: input.expectedTurnId,
              ...patch,
            };
            this.projection.touch(threadId);
            this.publishThread(threadId);
          }
          return { result: { threadId, turnId: input.expectedTurnId, applied: patch } };
        }),
      );
    this.liveSettingsWrites.set(threadId, writing);
    try {
      return await writing;
    } finally {
      if (this.liveSettingsWrites.get(threadId) === writing)
        this.liveSettingsWrites.delete(threadId);
    }
  }

  async interrupt(threadId: string, input: InterruptInput): Promise<Operation> {
    return this.perform('turn.interrupt', threadId, input, async () => {
      await this.requireActiveTurn(threadId, input.expectedTurnId);
      this.store.dispatch(input.clientOperationId);
      await this.codex.interruptTurn(threadId, input.expectedTurnId);
      // Upstream turn/completed is the only normal release; an interrupt receipt is not one.
      return { result: { threadId, turnId: input.expectedTurnId } };
    });
  }

  async resolveAction(actionId: string, input: ResolveActionInput): Promise<Operation> {
    return this.perform('action.resolve', actionId, input, async () => {
      this.ensureReady();
      let action = this.projection.actions.get(actionId);
      if (!action || action.codexEpoch !== this.codex.epoch || action.status === 'expired')
        throw new AppError('ACTION_EXPIRED', '该人工请求已失效', 409);
      if (action.status !== 'pending')
        throw new AppError('ACTION_CONFLICT', '该人工请求已由另一次提交处理', 409);
      if (action.threadId) await this.loadThread(action.threadId);
      // Recheck after the only async validation before the atomic in-memory claim.
      action = this.projection.actions.get(actionId);
      if (!action || action.status === 'expired' || action.codexEpoch !== this.codex.epoch)
        throw new AppError('ACTION_EXPIRED', '该人工请求已失效', 409);
      if (action.status !== 'pending')
        throw new AppError('ACTION_CONFLICT', '该人工请求已被处理', 409);
      this.validateResolution(action, input);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      this.projection.resolveAction(actionId, 'responding');
      if (action.threadId) this.publishThread(action.threadId);
      await this.codex.respond(actionId, input.resolution);
      if (action.kind === 'questions') {
        this.projection.resolveAction(actionId, 'responded');
        this.questionTracking.saveAction(
          action,
          questionAnswers(action.questions ?? [], input.resolution),
        );
        if (action.threadId) this.publishThread(action.threadId);
      }
      return { result: { actionId } };
    });
  }

  /** This ends Covro tracking only. It must never start/steer/interrupt a native turn. */
  async dismissQuestions(threadId: string, input: DismissQuestionsInput): Promise<Operation> {
    return this.perform('question.dismiss', threadId, input, async () => {
      await this.loadThread(threadId);
      const history = this.normalize(await this.codex.readThread(threadId));
      this.workspaces.assertOwnership(history.projectId, history.cwd, history.id);
      this.mergeQuestionHistory(history);
      const states = this.questionTracking.states(threadId);
      for (const id of new Set(input.questionIds)) {
        const question = this.findAsyncQuestion(history, id);
        if (!question) throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
        if (this.questionAnswered(history, id)) continue;
        if (states[id] && states[id].status !== 'dismissed')
          throw new AppError('QUESTION_BUSY', '回答正在提交或结果待核对，请刷新后继续', 409);
      }
      const ids = [...new Set(input.questionIds)].filter(
        (id) => !this.questionAnswered(history, id),
      );
      this.store.dispatch(input.clientOperationId);
      this.questionTracking.save(threadId, ids, 'dismissed', input.clientOperationId);
      this.publishThread(threadId);
      return { result: { threadId, questionIds: ids } };
    });
  }

  private mergeQuestionHistory(history: ThreadView): void {
    const index = this.questionHistory(history.id);
    if (index && !history.historyTruncated) index.observed = history.turns.map(questionEvidence);
    const current = this.projection.get(history.id);
    if (!current || (history.historyMode !== 'paginated' && !current.history)) {
      this.projection.thread(history, true);
      return;
    }
    // Question validation can inspect any saved turn. Only update turns already in the
    // live projection, preserving its history cursor and keeping old output off the wire.
    const visibleTurns = new Set(current.turns.map((turn) => turn.id));
    this.projection.thread(
      {
        ...history,
        history: current.history,
        turns: history.turns.filter((turn) => visibleTurns.has(turn.id)),
      },
      true,
    );
    if (index) this.publishThread(history.id);
  }

  private questionItems(history: ThreadView) {
    return [...history.turns, ...(this.projection.get(history.id)?.turns ?? [])].flatMap(
      (turn) => turn.items,
    );
  }

  private findAsyncQuestion(history: ThreadView, id: string) {
    const turns = new Map(
      (this.projection.get(history.id)?.turns ?? []).map((turn) => [turn.id, turn]),
    );
    for (const native of history.turns) turns.set(native.id, native);
    for (const turn of turns.values()) {
      if (!canTrackQuestions(turn.status)) continue;
      for (const item of turn.items) {
        if (item.type !== 'agentMessage') continue;
        const index = item.questions?.findIndex(
          (_, index) => asyncQuestionId(item.id, index) === id,
        );
        if (index !== undefined && index >= 0) return { item, question: item.questions![index]! };
      }
    }
  }

  private questionAnswered(history: ThreadView, id: string): boolean {
    const source = this.findAsyncQuestion(history, id);
    return Boolean(
      source &&
      this.questionItems(history).some((item) =>
        item.questionReplies?.some(
          (reply) =>
            reply.questionItemId === id ||
            (reply.questionItemId === source.item.id && reply.question === source.question.title),
        ),
      ),
    );
  }

  private async claimQuestionReplies(threadId: string, text: string, operationId: string) {
    const replies = parseQuestionReplies(text);
    if (!replies) return;
    // Read native history too: another client can have answered since our last notification.
    const history = this.normalize(await this.codex.readThread(threadId));
    this.workspaces.assertOwnership(history.projectId, history.cwd, history.id);
    this.mergeQuestionHistory(history);
    const states = this.questionTracking.states(threadId);
    const ids: string[] = [];
    for (const reply of replies) {
      // Legacy clients address a source item plus title rather than an indexed question.
      const source =
        this.findAsyncQuestion(history, reply.questionItemId) ??
        (() => {
          const item = this.questionItems(history).find((item) => item.id === reply.questionItemId);
          const index = item?.questions?.findIndex((q) => q.title === reply.question);
          return item && index !== undefined && index >= 0
            ? this.findAsyncQuestion(history, asyncQuestionId(item.id, index))
            : undefined;
        })();
      const index = source?.item.questions?.indexOf(source.question);
      if (!source || index === undefined)
        throw new AppError('QUESTION_EXPIRED', '该问题已不存在，请刷新会话', 409);
      if (!reply.answer.trim()) throw new AppError('VALIDATION_ERROR', '回答不能为空');
      const id = asyncQuestionId(source.item.id, index);
      if (states[id] || this.questionAnswered(history, id) || ids.includes(id))
        throw new AppError('QUESTION_CONFLICT', '该问题已处理或正在提交，请刷新会话', 409);
      ids.push(id);
    }
    this.questionTracking.save(threadId, ids, 'submitting', operationId);
  }

  getOperation(id: string): Operation {
    const row = this.store.get(id);
    if (!row) throw new AppError('OPERATION_NOT_FOUND', '未找到该操作', 404);
    return this.operation(row);
  }

  async reconcileOperation(targetOperationId: string, input: ReconcileInput): Promise<Operation> {
    return this.perform('operation.reconcile', targetOperationId, input, async () => {
      if (!input.confirmEnded)
        throw new AppError('CONFIRMATION_REQUIRED', '必须确认对应旧运行已经结束', 400);
      const target = this.store.get(targetOperationId);
      if (!target) throw new AppError('OPERATION_NOT_FOUND', '待核对操作不存在', 404);
      if (this.inFlightOperations.has(targetOperationId))
        throw new AppError('OPERATION_BUSY', '操作仍在处理中，请等待返回后再核对', 409);
      const marker = this.store.marker(targetOperationId);
      if (!marker || marker.endedAt !== null) {
        // Repeating a decision for an already released execution cannot touch a newer lock.
        this.store.dispatch(input.clientOperationId);
        this.store.reconcile(targetOperationId, input.clientOperationId);
        return { result: this.store.get(input.clientOperationId)?.result };
      }
      const cached = this.projection.get(marker.threadId);
      if (
        marker.codexEpoch === this.codex.epoch &&
        cached &&
        this.markerIsActive(cached, marker.turnId)
      )
        throw new AppError('THREAD_BUSY', '受管任务仍在执行，请先正常中断', 409, {
          threadId: marker.threadId,
        });
      if (this.codex.ready) {
        try {
          const actual = await this.codex.readThread(marker.threadId);
          const link = this.store.getThreadLink(marker.threadId);
          if (link) this.workspaces.assertOwnership(link.projectId, actual.cwd, actual.id);
          else this.workspaces.findOwner(actual.cwd, actual.id);
          if (this.markerIsActive(actual, marker.turnId))
            throw new AppError('THREAD_BUSY', '上游仍报告该任务活动，不能解除占用', 409, {
              threadId: marker.threadId,
            });
        } catch (error) {
          if (
            error instanceof AppError &&
            ['THREAD_BUSY', 'PROJECT_OWNERSHIP'].includes(error.code)
          )
            throw error;
          // Unavailable historical state still requires the explicit human confirmation above.
        }
      }
      const latest = this.projection.get(marker.threadId);
      if (
        marker.codexEpoch === this.codex.epoch &&
        latest &&
        this.markerIsActive(latest, marker.turnId)
      )
        throw new AppError('THREAD_BUSY', '受管任务仍在执行，请先正常中断', 409);
      this.store.dispatch(input.clientOperationId);
      this.store.reconcile(targetOperationId, input.clientOperationId);
      const thread = this.projection.get(marker.threadId);
      if (thread?.status === 'unknown') {
        thread.status = 'idle';
        this.publishThread(thread.id);
      }
      this.events.publish('operation', this.getOperation(targetOperationId), marker.threadId);
      return { result: this.store.get(input.clientOperationId)?.result };
    });
  }

  async subscribe(
    threadId: string,
    after: Cursor | undefined,
    listener: (message: ServerMessage) => void,
    incremental = false,
    signalReplayBoundary = false,
  ): Promise<() => void> {
    if (signalReplayBoundary) {
      // Cold and expired cursors use the authorized HTTP snapshot path.
      if (after?.serverEpoch !== this.events.serverEpoch || !this.projection.get(threadId)) {
        listener({ type: 'resync', cursor: this.events.cursor(), threadId });
        return () => {};
      }
      const thread = this.projection.get(threadId)!;
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    } else await this.getThread(threadId);
    return this.events.subscribe(
      threadId,
      () => this.detailThreadView(this.projection.get(threadId)!),
      after,
      listener,
      incremental,
      signalReplayBoundary,
    );
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stopLoopScheduler();
    await Promise.allSettled([...this.instructionWrites, ...this.defaultWrites]);
    this.capacityRetries.clearAll();
    this.questionHistories.clear();
    await this.projectClones.close();
    this.store.recover();
    this.projection.runtimeReset();
    this.removeListener();
    await this.codex.stop();
    await this.loopTick?.catch(() => {});
  }

  private async perform<T extends { clientOperationId: string }>(
    kind: string,
    target: string,
    input: T,
    work: () => Promise<{ result: unknown; turnId?: string; onAcknowledged?: () => void }>,
  ): Promise<Operation> {
    if (!this.accepting) throw new AppError('CODEX_UNAVAILABLE', '服务正在关闭', 503);
    if (this.maintenance && kind !== 'service.restart') throw this.maintenanceError();
    let accepted;
    try {
      accepted = this.store.accept(input.clientOperationId, kind, target, input);
    } catch (error) {
      throw this.asAppError(error);
    }
    const logger = this.logger.child({
      ...logContext(),
      operationId: input.clientOperationId,
      kind,
      ...(this.store.getThreadLink(target) ? { threadId: target } : {}),
    });
    const started = performance.now();
    if (!accepted.inserted) {
      logger.debug('operation.replayed', { state: accepted.operation.state, replayed: true });
      return this.operation(accepted.operation);
    }
    logger.info('operation.accepted');
    this.inFlightOperations.add(input.clientOperationId);
    try {
      const { result, turnId, onAcknowledged } = await withLogContext(
        { operationId: input.clientOperationId },
        work,
      );
      const operation = this.operation(
        this.store.acknowledge(input.clientOperationId, result, turnId),
      );
      logger.info('operation.acknowledged', {
        state: operation.status,
        turnId,
        durationMs: Math.round(performance.now() - started),
      });
      if (operation.status === 'acknowledged') onAcknowledged?.();
      this.events.publish('operation', operation);
      return operation;
    } catch (error) {
      const appError = this.asAppError(error);
      const state = this.store.get(input.clientOperationId)?.state;
      const dispatched = state === 'dispatching';
      const uncertain =
        state === 'unknown' ||
        (dispatched &&
          (typeof error === 'object' && error !== null && 'uncertain' in error
            ? Boolean(error.uncertain)
            : !(error instanceof AppError)));
      const operation = this.operation(
        this.store.fail(
          input.clientOperationId,
          { ...appError.toJSON(), code: uncertain ? 'RESULT_UNKNOWN' : appError.code },
          uncertain,
        ),
      );
      logger.warn('operation.failed', {
        state: operation.status,
        uncertain,
        ...errorFields(appError),
        durationMs: Math.round(performance.now() - started),
      });
      if (
        dispatched &&
        !uncertain &&
        kind === 'action.resolve' &&
        this.projection.actions.get(target)?.status === 'responding'
      ) {
        const action = this.projection.resolveAction(target, 'pending');
        if (action?.threadId) this.publishThread(action.threadId);
      }
      if (!uncertain && (kind === 'turn.start' || kind === 'turn.steer')) {
        this.questionTracking.release(input.clientOperationId);
        this.publishThread(target);
      }
      if (kind === 'turn.start')
        this.capacityRetries.dispatchFailed(target, input.clientOperationId);
      if (dispatched && (kind === 'turn.start' || kind === 'turn.steer'))
        this.publishThread(target);
      this.events.publish('operation', operation);
      if (uncertain)
        throw new AppError(
          'RESULT_UNKNOWN',
          '请求可能已经执行，结果待核对；请勿自动重新提交',
          409,
          { clientOperationId: input.clientOperationId },
        );
      throw appError;
    } finally {
      this.inFlightOperations.delete(input.clientOperationId);
      this.pendingThreadCreations.delete(input.clientOperationId);
      if (!this.store.activeForThread(target)) this.turnBaselines.delete(input.clientOperationId);
      if (kind === 'thread.compact' || kind === 'turn.start' || kind === 'turn.steer')
        this.publishThread(target);
    }
  }

  private normalize(thread: ThreadView, projectId?: string | null, managed = false): ThreadView {
    const link = this.store.getThreadLink(thread.id);
    const ownership = link
      ? this.workspaces.assertOwnership(link.projectId, thread.cwd, thread.id)
      : managed && projectId !== undefined
        ? this.workspaces.assertOwnership(projectId, thread.cwd, thread.id)
        : this.workspaces.findOwner(thread.cwd, thread.id);
    if (projectId !== undefined && ownership.projectId !== projectId)
      throw new AppError('PROJECT_OWNERSHIP', '会话属于其他项目，不能改变项目归属', 403);
    const managedEpoch = thread.archived
      ? null
      : managed
        ? this.codex.epoch
        : (link?.managedEpoch ?? null);
    const result: ThreadView = {
      ...thread,
      turns: this.turnUsage.restore(thread.id, thread.turns),
      projectId: ownership.projectId,
      cwd: ownership.cwd,
      managed: managedEpoch === this.codex.epoch,
      resumeError: managed ? undefined : this.projection.get(thread.id)?.resumeError,
      actions: [...this.projection.actions.values()].filter(
        (action) => action.threadId === thread.id,
      ),
    };
    this.store.linkThread({
      threadId: thread.id,
      projectId: ownership.projectId,
      cwd: ownership.cwd,
      source: thread.source,
      managedEpoch,
    });
    this.applyRecoveredMarker(result);
    return result;
  }

  private applyRecoveredMarker(thread: ThreadView): void {
    const marker = this.store.activeForThread(thread.id);
    if (marker?.state === 'unknown') {
      const confirmed = thread.turns.find((entry) => entry.id === marker.turnId);
      if (
        confirmed &&
        isTerminal(confirmed.status) &&
        !isActive(thread.status) &&
        !thread.turns.some((entry) => isActive(entry.status))
      ) {
        this.store.finishTurn(thread.id, confirmed.id, marker.codexEpoch);
        return;
      }
      thread.status = 'unknown';
      const turn = thread.turns.find((entry) => entry.id === marker.turnId);
      if (turn && !isTerminal(turn.status)) turn.status = 'unknown';
    }
  }

  /** Refresh only this thread; missing completion events must not block its next turn. */
  private async refreshExecution(marker: ExecutionMarker): Promise<void> {
    if (!this.codex.ready) return;
    const existing = this.executionReads.get(marker.operationId);
    if (existing) return existing;
    const epoch = this.codex.epoch;
    const revision = this.projection.revision(marker.threadId);
    const reading = (async () => {
      try {
        const current = () => {
          const latest = this.store.activeForThread(marker.threadId);
          // A delayed read cannot release a replacement execution or overwrite newer live events.
          return this.codex.ready &&
            this.codex.epoch === epoch &&
            latest?.operationId === marker.operationId &&
            latest.turnId === marker.turnId &&
            latest.codexEpoch === marker.codexEpoch &&
            this.projection.revision(marker.threadId) === revision
            ? latest
            : undefined;
        };
        const actual = await ((marker.turnId &&
          this.codex.readExecutionHistory?.(marker.threadId, marker.turnId)) ||
          this.codex.readThread(marker.threadId));
        const latest = current();
        if (!latest || actual.id !== marker.threadId) return;
        const link = this.store.getThreadLink(marker.threadId);
        const ownership = link
          ? this.workspaces.assertOwnership(link.projectId, actual.cwd, actual.id)
          : this.workspaces.findOwner(actual.cwd, actual.id);
        if (ownership.workspaceKey !== marker.workspaceKey) return;
        // A lost start receipt can leave turnId absent. Only the native client ID,
        // never matching text, timestamps or an arbitrary terminal turn, can bind it.
        const candidates = marker.turnId
          ? actual.turns.filter((entry) => entry.id === marker.turnId)
          : actual.turns.filter((entry) =>
              entry.items.some(
                (item) => item.type === 'userMessage' && item.clientId === marker.operationId,
              ),
            );
        const turn = candidates.length === 1 ? candidates[0] : undefined;
        if (!turn) return;
        const restoreActive =
          isActive(turn.status) &&
          latest.state === 'active' &&
          this.projection.get(marker.threadId)?.status === 'unknown';
        const ended =
          isTerminal(turn.status) &&
          !isActive(actual.status) &&
          !actual.turns.some((entry) => isActive(entry.status));
        if (!restoreActive && !ended) return;

        const page =
          actual.historyMode === 'paginated' && this.codex.readThreadPage
            ? await this.codex.readThreadPage(marker.threadId, undefined, { deferOutput: true })
            : actual;
        if (!current() || page.id !== marker.threadId) return;
        if (
          this.workspaces.assertOwnership(ownership.projectId, page.cwd, page.id).workspaceKey !==
          marker.workspaceKey
        )
          return;
        // Only the recent display page enters the projection. Keep an older known turn's
        // recovered status when it is already represented by a live event.
        if (ended && (isActive(page.status) || page.turns.some((entry) => isActive(entry.status))))
          return;
        if (restoreActive) {
          this.projection.thread(this.normalize(page));
          this.publishThread(marker.threadId);
          return;
        }
        if (!marker.turnId) this.store.attachTurn(marker.operationId, turn.id);
        this.store.finishTurn(marker.threadId, turn.id, marker.codexEpoch);
        this.logger.info('execution.recovered', {
          operationId: marker.operationId,
          threadId: marker.threadId,
          turnId: turn.id,
          codexEpoch: marker.codexEpoch,
          reason: marker.turnId ? 'terminal_history' : 'native_message_identity',
        });
        this.projection.thread(this.normalize(page));
        if (
          !page.turns.some((entry) => entry.id === turn.id) &&
          this.projection.get(marker.threadId)?.turns.some((entry) => entry.id === turn.id)
        )
          this.projection.turn(marker.threadId, turn);
        this.projection.expireTurn(marker.threadId, turn.id);
        this.publishThread(marker.threadId);
        this.events.publish('operation', this.getOperation(marker.operationId), marker.threadId);
      } catch (error) {
        // Missing/unavailable history is not terminal evidence. Keep the durable reservation.
        this.logger.debug('execution.recovery_read_failed', {
          threadId: marker.threadId,
          operationId: marker.operationId,
          ...errorFields(error),
        });
      }
    })();
    this.executionReads.set(marker.operationId, reading);
    try {
      return await reading;
    } finally {
      this.executionReads.delete(marker.operationId);
    }
  }

  private ensureReady(): void {
    if (!this.codex.ready)
      throw new AppError('CODEX_UNAVAILABLE', 'Codex 尚未就绪，请查看运行状态', 503);
  }

  private compatibilityFingerprint(diagnostics: CodexDiagnostics): string {
    return JSON.stringify([
      diagnostics.codexEpoch,
      diagnostics.codexVersion,
      diagnostics.verifiedVersion,
    ]);
  }

  private compatibilityConfirmation(
    diagnostics: CodexDiagnostics,
  ): SystemInfo['compatibilityConfirmation'] {
    const fingerprint = this.compatibilityFingerprint(diagnostics);
    if (
      !this.codex.ready ||
      !diagnostics.ready ||
      diagnostics.compatibility !== 'unverified' ||
      !diagnostics.codexVersion ||
      this.confirmedCompatibility !== fingerprint
    )
      this.confirmedCompatibility = undefined;
    if (diagnostics.compatibility !== 'unverified') return 'not-required';
    return this.confirmedCompatibility === fingerprint ? 'confirmed' : 'required';
  }

  private ensureCompatibilityAvailable(diagnostics: CodexDiagnostics): void {
    this.compatibilityConfirmation(diagnostics);
    this.ensureReady();
    if (
      !diagnostics.ready ||
      diagnostics.compatibility === 'unavailable' ||
      !diagnostics.codexVersion
    )
      throw new AppError('CODEX_UNAVAILABLE', 'Codex 不可用或无法识别运行版本，请先检查诊断', 503);
  }

  private ensureCompatibilityConfirmed(): void {
    const diagnostics = this.codex.diagnostics();
    this.ensureCompatibilityAvailable(diagnostics);
    if (this.compatibilityConfirmation(diagnostics) === 'required')
      throw new AppError(
        'COMPATIBILITY_CONFIRMATION_REQUIRED',
        '当前 Codex 版本尚未验证，请先确认继续使用此版本',
        409,
      );
  }

  private ensureManaged(thread: ThreadView): void {
    this.ensureReady();
    this.ensureArchiveAvailable(thread);
    if (thread.archived) throw new AppError('THREAD_ARCHIVED', '请先取消归档后再继续对话', 409);
    if (!thread.managed || this.store.getThreadLink(thread.id)?.managedEpoch !== this.codex.epoch)
      throw new AppError('THREAD_NOT_RESUMED', '会话尚未恢复，请重试恢复后继续', 409);
  }

  private async requireActiveTurn(threadId: string, expectedTurnId: string): Promise<void> {
    const thread = await this.loadThread(threadId);
    this.ensureManaged(thread);
    const turn = thread.turns.find((entry) => entry.id === expectedTurnId);
    const marker = this.store.activeForThread(threadId);
    if (
      !turn ||
      !isActive(turn.status) ||
      !marker ||
      marker.turnId !== expectedTurnId ||
      marker.codexEpoch !== this.codex.epoch
    )
      throw new AppError('TURN_CONFLICT', '目标任务已改变或不再活动，请刷新状态', 409);
  }

  private markerIsActive(thread: ThreadView, turnId: string | null): boolean {
    if (turnId) return thread.turns.some((turn) => turn.id === turnId && isActive(turn.status));
    return isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status));
  }

  private validateResolution(action: PendingAction, input: ResolveActionInput): void {
    const resolution = input.resolution;
    if (action.kind === 'permissions') {
      validatePermissionResolution(resolution);
    } else if (action.kind === 'elicitation') {
      validateElicitationResolution(action.elicitation, resolution);
    } else if (action.kind === 'questions') {
      questionAnswers(action.questions ?? [], resolution);
    } else if (
      !('decision' in resolution) ||
      'content' in resolution ||
      'persist' in resolution ||
      !action.options.some((option) => option.id === resolution.decision)
    )
      throw new AppError('VALIDATION_ERROR', '请选择上游提供的合法选项');
  }

  private operation(row: OperationRow): Operation {
    const marker = this.store.marker(row.clientOperationId);
    return {
      clientOperationId: row.clientOperationId,
      kind: row.kind,
      target: row.target,
      status: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.result === null
        ? {}
        : {
            result:
              row.kind === 'session.create'
                ? sessionCreationResult(this.store, row.result)
                : row.result,
          }),
      ...(row.error === null
        ? {}
        : { error: { ...row.error, clientOperationId: row.clientOperationId } }),
      ...(marker
        ? {
            execution: {
              operationId: marker.operationId,
              threadId: marker.threadId,
              ...(marker.turnId === null ? {} : { turnId: marker.turnId }),
              workspaceKey: marker.workspaceKey,
              codexEpoch: marker.codexEpoch,
              ended: marker.endedAt !== null,
            },
          }
        : {}),
      ...(row.reconciledAt
        ? {
            reconciliation: {
              at: row.reconciledAt,
              decision: row.reconciliationDecision ?? 'confirmed-ended',
            },
          }
        : {}),
    };
  }

  private asAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof StoreConflict)
      return new AppError(
        error.code,
        error.message,
        409,
        error.threadId ? { threadId: error.threadId } : undefined,
      );
    return new AppError('INTERNAL_ERROR', error instanceof Error ? error.message : '未知错误', 500);
  }

  private publishThread(threadId: string, streamed?: StreamedItem): void {
    const thread = this.projection.get(threadId);
    if (!thread) return;
    const view = this.detailThreadView(thread, false, !streamed || !thread.pendingQuestions);
    if (view.pendingQuestions) thread.pendingQuestions = view.pendingQuestions;
    this.events.publishThread(view, streamed);
    const summary = toThreadSummary({ ...view, turns: thread.turns });
    const encoded = JSON.stringify(summary);
    if (this.summaries.get(threadId) === encoded) return;
    try {
      this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    } catch {
      return;
    }
    this.summaries.set(threadId, encoded);
    this.events.publishSummary(summary);
  }

  private historyVisible(thread: ThreadView): boolean {
    return Boolean(
      thread.hasMessages ||
      thread.archived ||
      thread.goal ||
      thread.turns.length ||
      this.store.activeForThread(thread.id) ||
      isActive(thread.status) ||
      thread.actions.some((action) => ['pending', 'responding'].includes(action.status)),
    );
  }

  private retryLinks(threadId: string): Map<string, string> {
    let links = this.capacityLinks.get(threadId);
    if (!links) {
      links = this.store.capacityRetryTurns(threadId);
      this.capacityLinks.set(threadId, links);
    }
    return links;
  }

  private detailThreadView(thread: ThreadView, copy = true, includeQuestions = true): ThreadView {
    if (thread.historyMode !== 'paginated') return this.threadView(thread, copy, includeQuestions);
    const bounded = thread.turns.length > HISTORY_PAGE_SIZE;
    const history = bounded
      ? {
          olderCursor: historyCursor(thread.id, this.codex.epoch, {
            beforeTurnId: thread.turns[thread.turns.length - HISTORY_PAGE_SIZE]!.id,
          }),
        }
      : thread.history;
    let turns = bounded ? thread.turns.slice(-HISTORY_PAGE_SIZE) : thread.turns;
    if (this.codex.canReadDeferredOutput?.()) {
      turns = turns.map((turn) =>
        isTerminal(turn.status)
          ? {
              ...turn,
              items: turn.items.map(deferLiveToolOutput),
            }
          : turn,
      );
    }
    const result = this.threadView({ ...thread, turns, history }, copy, false);
    if (includeQuestions)
      result.pendingQuestions = this.questionState({
        ...result,
        turns: thread.turns,
        history: thread.history,
      });
    return result;
  }

  private threadView(thread: ThreadView, copy = true, includeQuestions = true): ThreadView {
    const submissions = new Map(
      this.store.pendingMessages(thread.id).map((message) => [message.id, message]),
    );
    if (submissions.size)
      for (const turn of thread.turns)
        for (const item of turn.items) {
          const pending = item.clientId ? submissions.get(item.clientId) : undefined;
          if (pending && (!pending.turnId || pending.turnId === turn.id)) {
            Object.assign(item, mergeUserMessage(item, pending.item));
            this.store.confirmMessage(thread.id, turn.id, item);
          }
        }
    const result = copy ? structuredClone(thread) : { ...thread };
    const pendingMessages = this.store.pendingMessages(thread.id);
    if (pendingMessages.length) result.pendingMessages = pendingMessages;
    else delete result.pendingMessages;
    // Most threads have no empty-input continuation, so defer the operation-history lookup.
    const links =
      this.capacityLinks.get(thread.id) ??
      (thread.turns.some((turn) => !turn.items.some((item) => item.type === 'userMessage'))
        ? this.retryLinks(thread.id)
        : undefined);
    result.turns = result.turns.map((turn) => {
      const root = links?.get(turn.id);
      return root ? { ...turn, retryOf: root } : turn;
    });
    const retry = this.capacityRetries.view(thread.id);
    if (retry) result.capacityRetry = structuredClone(retry);
    else delete result.capacityRetry;
    if (this.capacityRetries.pending(thread.id)) result.status = 'running';
    result.questionTracking = this.questionTracking.states(thread.id);
    const savedActions = this.questionTracking.actions(thread.id);
    const actions = new Map(savedActions.map((action) => [action.actionId, action]));
    for (const action of thread.actions)
      if (
        action.status === 'pending' ||
        action.status === 'responding' ||
        !actions.has(action.actionId)
      )
        actions.set(action.actionId, action);
    result.actions = [...actions.values()];
    result.archived = thread.archived ?? false;
    if (includeQuestions) result.pendingQuestions = this.questionState(result);
    result.historyVisible = this.historyVisible(thread);
    const marker = this.store.activeForThread(thread.id);
    delete result.execution;
    if (marker)
      result.execution = {
        operationId: marker.operationId,
        threadId: marker.threadId,
        ...(marker.turnId === null ? {} : { turnId: marker.turnId }),
        workspaceKey: marker.workspaceKey,
        codexEpoch: marker.codexEpoch,
        ended: false,
      };
    return result;
  }

  private beginTitleRead(threadId: string): number {
    const sequence = ++this.titleReadSequence;
    this.titleReads.set(threadId, sequence);
    return sequence;
  }

  private updateThreadTitle(threadId: string, title: string, sequence: number): void {
    const thread = this.projection.get(threadId);
    if (!thread || this.titleReads.get(threadId) !== sequence || thread.title === title) return;
    thread.title = title;
    this.projection.touch(threadId);
    this.publishThread(threadId);
  }

  private async refreshThreadMetadata(threadId: string): Promise<void> {
    const sequence = this.beginTitleRead(threadId);
    const revision = this.projection.revision(threadId);
    try {
      const thread = await this.codex.readThreadMetadata(threadId);
      const current = this.projection.get(threadId);
      if (!current || thread.id !== threadId) return;
      this.workspaces.assertOwnership(current.projectId, thread.cwd, thread.id);
      const settings = thread.runtimeSettings
        ? { ...current.runtimeSettings, ...thread.runtimeSettings }
        : undefined;
      if (
        this.titleReads.get(threadId) === sequence &&
        this.projection.revision(threadId) === revision &&
        settings &&
        JSON.stringify(current.runtimeSettings) !== JSON.stringify(settings)
      ) {
        if (current.runtimeSettings?.model !== settings.model)
          this.projection.invalidateContext(threadId, 'modelChanged');
        current.runtimeSettings = settings;
        this.projection.touch(threadId);
        this.publishThread(threadId);
      }
      if (this.titleReads.get(threadId) === sequence)
        this.updateArchiveState(threadId, Boolean(thread.archived));
      this.updateThreadTitle(threadId, thread.title, sequence);
    } catch {
      // Metadata refresh must not break live execution when upstream is unavailable.
      // The next list/detail read or turn notification will retry.
    }
  }

  private consume(event: CodexEvent): void {
    if (event.type === 'previewExecution') return;
    if (
      event.type === 'runtime' &&
      (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.currentEpoch)
    )
      this.capacityRetries.clearAll();
    const eventThread =
      event.type === 'action'
        ? event.action.threadId
        : 'threadId' in event
          ? event.threadId
          : undefined;
    const eventMarker = eventThread ? this.store.activeForThread(eventThread) : undefined;
    const matchesDispatch =
      event.type !== 'turn' ||
      eventMarker?.turnId === event.turn.id ||
      (eventMarker?.turnId === null &&
        this.turnBaselines.get(eventMarker.operationId)?.has(event.turn.id) === false);
    this.capacityRetries.observe(event, matchesDispatch ? eventMarker?.operationId : undefined);
    if (event.type === 'turn') {
      const job = this.capacityRetries.current(event.threadId);
      if (job?.attempt && job.turnId === event.turn.id && job.rootTurnId)
        this.retryLinks(event.threadId).set(event.turn.id, job.rootTurnId);
    }
    if (event.type === 'runtime') {
      if (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.currentEpoch)
        this.loopsOffline = true;
      this.compatibilityConfirmation(event.diagnostics);
      if (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.currentEpoch) {
        this.currentEpoch = event.diagnostics.codexEpoch;
        this.titleReads.clear();
        this.runtimeSettingsUpdates.clear();
        this.turnBaselines.clear();
        this.resumes.clear();
        this.questionHistories.clear();
        this.store.recover();
        this.projection.runtimeReset();
        for (const thread of this.projection.values()) this.publishThread(thread.id);
      }
      this.events.publish('runtime', this.getSystem());
      return;
    }
    if (event.type === 'thread') {
      try {
        // Upstream can announce a new thread before its creation response. Wait for
        // that response to bind the selected ID, including grandfathered JSON aliases.
        if (
          !this.store.getThreadLink(event.thread.id) &&
          [...this.pendingThreadCreations.values()].includes(realpathSync(event.thread.cwd))
        )
          return;
        this.projection.thread(this.normalize(event.thread), true);
        this.publishThread(event.thread.id);
      } catch {
        /* Events outside registered projects are not exposed. */
      }
      return;
    }
    if (event.type === 'threadArchive') {
      this.beginTitleRead(event.threadId);
      this.updateArchiveState(event.threadId, event.archived);
      return;
    }
    if (event.type === 'action') {
      const action = event.action;
      if (action.codexEpoch !== this.codex.epoch) return;
      const known = this.projection.actions.has(action.actionId);
      const owner = action.threadId ? this.projection.get(action.threadId) : undefined;
      const previous = new Set(
        owner ? pendingAttention(this.threadView(owner, false, false)).map(attentionKey) : [],
      );
      this.projection.action(action);
      if (action.kind === 'questions') this.questionTracking.saveAction(action);
      if (action.threadId) {
        this.publishThread(action.threadId);
        if (!known) this.publishNewAttention(action.threadId, previous);
      }
      return;
    }
    if (event.type === 'actionResolved') {
      const action = this.projection.resolveAction(event.actionId, 'responded');
      if (action?.kind === 'questions') this.questionTracking.saveAction(action);
      if (action?.threadId) this.publishThread(action.threadId);
      return;
    }
    if (event.type === 'autoReview') {
      if (this.projection.autoReview(event.threadId, event.turnId, event.review))
        this.publishThread(event.threadId);
      return;
    }
    const thread = this.projection.get(event.threadId);
    if (!thread) return;
    if (event.type === 'goal') {
      thread.goal = event.goal;
      this.projection.touch(thread.id);
      this.publishThread(thread.id);
      return;
    }
    const previousAttention = new Set(
      event.type === 'item' || event.type === 'turn'
        ? pendingAttention(this.threadView(thread, false, false)).map(attentionKey)
        : [],
    );
    if (event.type === 'tokenUsage') {
      if (this.projection.tokenUsage(thread.id, event.usage)) this.publishThread(thread.id);
      return;
    }
    if (event.type === 'compactionCompleted') {
      this.projection.compactionCompleted(thread.id, event.turnId);
      this.publishThread(thread.id);
      return;
    }
    if (event.type === 'turnError' || event.type === 'turnProgress') {
      const changed =
        event.type === 'turnError'
          ? this.projection.turnError(
              thread.id,
              event.turnId,
              event.message,
              event.willRetry,
              event,
            )
          : this.projection.turnProgress(thread.id, event.turnId);
      if (changed) this.publishThread(thread.id);
      return;
    }
    if (event.type === 'threadName') {
      // Also invalidate history reads when the notification repeats the current name.
      this.projection.touch(thread.id);
      if (event.name) this.updateThreadTitle(thread.id, event.name, this.beginTitleRead(thread.id));
      else void this.refreshThreadMetadata(thread.id);
      return;
    }
    if (event.type === 'threadSettings') {
      if (thread.runtimeSettings?.model !== event.settings.model)
        this.projection.invalidateContext(thread.id, 'modelChanged');
      this.runtimeSettingsUpdates.set(thread.id, ++this.runtimeSettingsSequence);
      thread.runtimeSettings = event.settings;
      this.projection.touch(thread.id);
    } else if (event.type === 'threadStatus') {
      if (!isActive(event.status)) this.projection.endThreadCompactions(thread.id);
      // Idle/notLoaded is not proof that an uncertain execution finished.
      if (this.store.activeForThread(thread.id)?.state !== 'unknown') thread.status = event.status;
      this.projection.touch(thread.id);
    } else if (event.type === 'turn') {
      const previous = thread.turns.find((turn) => turn.id === event.turn.id);
      if (
        thread.goal &&
        !isTerminal(event.turn.status) &&
        (!previous || !isTerminal(previous.status)) &&
        !this.store.activeForThread(thread.id) &&
        this.store.getThreadLink(thread.id)?.managedEpoch === this.codex.epoch
      ) {
        try {
          const ownership = this.workspaces.assertOwnership(
            thread.projectId,
            thread.cwd,
            thread.id,
          );
          const operationId = randomUUID();
          this.store.accept(operationId, 'goal.continue', thread.id, {
            turnId: event.turn.id,
            codexEpoch: this.codex.epoch,
          });
          this.store.dispatch(operationId, {
            threadId: thread.id,
            workspaceKey: ownership.workspaceKey,
            codexEpoch: this.codex.epoch,
          });
          this.store.attachTurn(operationId, event.turn.id);
          this.store.acknowledge(
            operationId,
            { threadId: thread.id, turnId: event.turn.id },
            event.turn.id,
          );
        } catch {
          /* Existing reservations remain authoritative. Never issue a new turn here. */
        }
      }
      const newCompletion = !previous || !isTerminal(previous.status);
      if (isTerminal(event.turn.status)) this.turnUsage.save(thread.id, event.turn);
      this.projection.turn(thread.id, event.turn);
      // Preview changes do not have a dedicated notification. Read the upstream
      // title at turn boundaries, including the first prompt of a new thread.
      void this.refreshThreadMetadata(thread.id);
      const marker = this.store.activeForThread(thread.id);
      if (
        marker?.codexEpoch === this.codex.epoch &&
        marker.turnId === null &&
        // A cancellation event from an existing turn cannot identify newly
        // dispatched work, even when its first notification/receipt is delayed.
        this.turnBaselines.get(marker.operationId)?.has(event.turn.id) === false
      ) {
        this.store.attachTurn(marker.operationId, event.turn.id);
        this.turnBaselines.delete(marker.operationId);
      }
      if (isTerminal(event.turn.status)) {
        if (marker?.turnId === event.turn.id || (matchesDispatch && eventMarker?.turnId === null))
          this.recordLoopTurn(
            (marker ?? eventMarker)!.operationId,
            event.turn.status,
            event.turn.id,
          );
        this.store.finishTurn(thread.id, event.turn.id, this.codex.epoch);
        this.projection.expireTurn(thread.id, event.turn.id);
        if (newCompletion && !this.capacityRetries.pending(thread.id)) {
          try {
            this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
            this.events.publishCompletion({
              threadId: thread.id,
              turnId: event.turn.id,
              projectId: thread.projectId,
              title: thread.title,
              status: event.turn.status as 'completed' | 'failed' | 'interrupted',
            });
          } catch {
            // Removed or unavailable projects must not disclose completion metadata.
          }
        }
      }
    } else if (event.type === 'item') this.projection.item(thread.id, event.turnId, event.item);
    else if (event.type === 'delta')
      this.projection.delta(
        thread.id,
        event.turnId,
        event.itemId,
        event.field,
        event.delta,
        event.itemType,
      );
    else if (event.type === 'diff') {
      this.projection.diff(thread.id, event.turnId, event.diff);
    }
    this.publishThread(thread.id, event.type === 'delta' ? event : undefined);
    if (event.type === 'item' || event.type === 'turn')
      this.publishNewAttention(thread.id, previousAttention);
  }

  private publishNewAttention(threadId: string, previous: Set<string>): void {
    try {
      for (const request of this.getThreadAttention(threadId))
        if (!previous.has(attentionKey(request))) this.events.publishAttention(request);
    } catch {
      // Removed or unavailable projects must not disclose request metadata.
    }
  }
}

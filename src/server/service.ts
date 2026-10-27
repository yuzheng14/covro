import type { CodexClient, CodexDiagnostics, CodexEvent } from '../codex/types.js';
import { CapacityRetries, type CapacityAttempt } from './capacity-retry.js';
import { isModelCapacityError } from '../shared/turn-errors.js';
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
import {
  validateElicitationResolution,
  validatePermissionResolution,
} from '../shared/elicitation.js';
import { toThreadSummary } from '../shared/thread-summary.js';
import type {
  ArchiveThreadInput,
  ConfirmCompatibilityInput,
  CreateProjectInput,
  CloneProjectInput,
  CreateThreadInput,
  Cursor,
  ForkThreadInput,
  InterruptInput,
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
  StoreConflict,
  type ExecutionMarker,
  type OperationRow,
} from './db/operations.js';
import { EventHub } from './events.js';
import { TurnUsageStore } from './db/turn-usage.js';
import { Projection, isActive, isTerminal } from './projection.js';
import { ProjectRegistry } from './projects.js';
import { ProjectClones } from './project-clones.js';
import { renderThreadExport } from './thread-export.js';
import { readLocalImage } from './images.js';
import { temporaryFileRoots, type FileScope } from './local-files.js';
import { readLocalMarkdown } from './markdown.js';
import { readLocalText } from './text-files.js';
import { readLocalJson } from './json-files.js';

export interface GatewayOptions {
  store: OperationStore;
  projects: ProjectRegistry;
  workspacesRoot?: string;
  codex: CodexClient;
  limits?: { eventBytes: number; itemBytes: number; wsBytes?: number };
  authMode?: SystemInfo['authMode'];
  demo?: boolean;
}

/** Coordinates durable intent, upstream effects, and the recoverable browser projection. */
export class GatewayService {
  private readonly capacityRetries: CapacityRetries;
  readonly projectClones: ProjectClones;
  readonly shell: ShellService;
  readonly events: EventHub;
  readonly projection: Projection;
  private readonly store: OperationStore;
  private readonly turnUsage: TurnUsageStore;
  private readonly projects: ProjectRegistry;
  private readonly workspaces: WorkspaceRegistry;
  private readonly codex: CodexClient;
  private readonly removeListener: () => void;
  private readonly fileTemporaryRoots = temporaryFileRoots();
  private accepting = true;
  private maintenance = false;
  private maintenanceReason: 'update' | 'backup' = 'update';
  private currentEpoch: string;
  private confirmedCompatibility: string | undefined;
  private readonly archiveChanges = new Set<string>();
  private readonly archiveRevisions = new Map<string, number>();
  private readonly turnBaselines = new Map<string, Set<string>>();
  private readonly renameChanges = new Set<string>();
  private readonly reads = new Map<string, Promise<ThreadView>>();
  private readonly resumes = new Map<string, Promise<void>>();
  private readonly executionReads = new Map<string, Promise<void>>();
  private readonly summaries = new Map<string, string>();
  // Request ordering only: title values always come from app-server.
  private titleReadSequence = 0;
  private readonly titleReads = new Map<string, number>();
  // A status/title/history update must not discard a lifecycle response's full configuration.
  private runtimeSettingsSequence = 0;
  private readonly runtimeSettingsUpdates = new Map<string, number>();
  private readonly inFlightOperations = new Set<string>();
  private readonly pendingThreadCreations = new Map<string, string>();
  private readonly capacityLinks = new Map<string, Map<string, string>>();

  constructor(private readonly options: GatewayOptions) {
    this.store = options.store;
    this.turnUsage = new TurnUsageStore(this.store.database);
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
    );
    this.codex = options.codex;
    this.shell = new ShellService(this.codex);
    this.events = new EventHub(options.limits?.eventBytes);
    this.projection = new Projection(options.limits?.itemBytes);
    this.capacityRetries = new CapacityRetries(
      (job) => this.dispatchCapacityRetry(job),
      (id) => this.publishThread(id),
    );
    this.currentEpoch = this.codex.epoch;
    this.store.recover();
    this.removeListener = this.codex.onEvent((event) => this.consume(event));
  }

  listProjects() {
    return this.projects.list();
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
  setMaintenance(value: boolean, reason: 'update' | 'backup' = 'update') {
    this.maintenance = value;
    this.maintenanceReason = reason;
  }
  maintenanceError() {
    return this.maintenanceReason === 'backup'
      ? new AppError('BACKUP_MAINTENANCE', '正在备份，请完成后重试。', 503)
      : new AppError('UPDATE_MAINTENANCE', '正在升级，请等待服务重新连接', 503);
  }
  prepareUpdate(reason: 'update' | 'backup' = 'update'): { ready: boolean; reason?: string } {
    if (this.capacityRetries.active())
      return { ready: false, reason: '等待模型容量重试结束或取消' };
    if (this.projectClones.hasActive) return { ready: false, reason: '等待项目克隆完成或取消' };
    if (this.shell.active()) return { ready: false, reason: '等待 Shell 命令结束' };
    if (this.inFlightOperations.size || this.resumes.size || this.pendingThreadCreations.size)
      return { ready: false, reason: '等待正在提交或恢复的操作完成' };
    if (this.store.activeMarkers().length || this.store.unresolvedOperations().length)
      return { ready: false, reason: '等待任务结束，并核对结果尚未确认的操作' };
    if (
      this.projection.values().some((thread) => thread.managed && isActive(thread.status)) ||
      [...this.projection.actions.values()].some((action) =>
        ['pending', 'responding'].includes(action.status),
      )
    )
      return { ready: false, reason: '等待执行中的任务、审批或输入结束' };
    // Synchronous gate and check share one event-loop boundary with perform().
    this.setMaintenance(true, reason);
    return { ready: true };
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

  async readRuntimeSettings(projectId: string | null) {
    const cwd =
      projectId === null
        ? this.workspaces.defaultsDirectory()
        : this.projects.get(projectId).canonicalRoot;
    return this.codex.readRuntimeSettings(cwd);
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

  async getThreadMetadata(threadId: string): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    if (cached) {
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      if (this.codex.ready) await this.refreshThreadMetadata(threadId);
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      return { ...this.threadView(cached), turns: [], actions: [] };
    }
    // Checking a remembered ID must not load history or resume an unsent thread.
    const metadata = this.threadView(this.normalize(await this.codex.readThreadMetadata(threadId)));
    return { ...metadata, turns: [], actions: [] };
  }

  async getThread(threadId: string): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    await this.loadThread(threadId);
    if (cached && this.codex.ready) await this.refreshThreadMetadata(threadId);
    const thread = this.projection.get(threadId)!;
    // A completed project can be removed while its metadata request is in flight.
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    return this.threadView(thread);
  }

  getThreadAttention(threadId: string) {
    const thread = this.projection.get(threadId);
    if (!thread) return [];
    this.workspaces.assertOwnership(thread.projectId, thread.cwd, thread.id);
    return pendingAttention(thread);
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
    const page = this.normalize(await this.codex.readThreadPage(threadId, cursor));
    this.workspaces.assertOwnership(page.projectId, page.cwd, page.id);
    const links = this.retryLinks(threadId);
    for (const turn of page.turns) {
      const root = links.get(turn.id);
      if (root) turn.retryOf = root;
    }
    return page;
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

  private async loadThread(threadId: string): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    if (cached) {
      this.workspaces.assertOwnership(cached.projectId, cached.cwd, cached.id);
      const marker = this.store.activeForThread(threadId);
      if (marker?.turnId && this.codex.ready) {
        await this.refreshExecution(marker);
        return this.threadView(cached);
      }
      // Managed ownership does not make an unknown projection authoritative.
      if (
        ((cached.managed || isActive(cached.status)) && cached.status !== 'unknown') ||
        !this.codex.ready
      )
        return this.threadView(cached);
    }
    const existing = this.reads.get(threadId);
    if (existing) return this.threadView(await existing);
    const revision = this.projection.revision(threadId);
    const loading = (async () => {
      const thread = this.normalize(
        await (this.codex.readThreadPage?.(threadId) ?? this.codex.readThread(threadId)),
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
      return this.threadView(await loading);
    } finally {
      this.reads.delete(threadId);
    }
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
            const resumed = await this.codex.resumeThread(threadId, ownership.cwd, input.settings);
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
      const source = this.projection.get(threadId) ?? (await this.codex.readThread(threadId));
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
      const forked = await this.codex.forkThread(threadId, forkCwd, input.settings);
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
    return this.dispatchTurn(threadId, input);
  }

  private async dispatchTurn(
    threadId: string,
    input: StartTurnInput,
    retry?: CapacityAttempt,
    expectedTurnId?: string,
  ): Promise<Operation> {
    return this.perform('turn.start', threadId, input, async () => {
      if (!retry && !expectedTurnId && this.capacityRetries.view(threadId)?.status === 'waiting')
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
      this.store.dispatch(input.clientOperationId, {
        threadId,
        workspaceKey: ownership.workspaceKey,
        codexEpoch: this.codex.epoch,
      });
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
        input.taskKind === 'init' ? PROJECT_INIT_PROMPT : input.text,
        input.settings,
        input.images,
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
      if (projectedTurn && isTerminal(projectedTurn.status))
        this.store.finishTurn(threadId, turn.id, this.codex.epoch);
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
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      const result = await this.codex.steerTurn(
        threadId,
        input.expectedTurnId,
        input.text,
        input.images,
      );
      return { result: { threadId, turnId: result.turnId } };
    });
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
      return { result: { actionId } };
    });
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
  ): Promise<() => void> {
    await this.getThread(threadId);
    return this.events.subscribe(
      threadId,
      () => this.threadView(this.projection.get(threadId)!),
      after,
      listener,
    );
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    this.capacityRetries.clearAll();
    await this.projectClones.close();
    this.store.recover();
    this.projection.runtimeReset();
    this.removeListener();
    await this.codex.stop();
  }

  private async perform<T extends { clientOperationId: string }>(
    kind: string,
    target: string,
    input: T,
    work: () => Promise<{ result: unknown; turnId?: string; onAcknowledged?: () => void }>,
  ): Promise<Operation> {
    if (!this.accepting) throw new AppError('CODEX_UNAVAILABLE', '服务正在关闭', 503);
    if (this.maintenance) throw this.maintenanceError();
    let accepted;
    try {
      accepted = this.store.accept(input.clientOperationId, kind, target, input);
    } catch (error) {
      throw this.asAppError(error);
    }
    if (!accepted.inserted) return this.operation(accepted.operation);
    this.inFlightOperations.add(input.clientOperationId);
    try {
      const { result, turnId, onAcknowledged } = await work();
      const operation = this.operation(
        this.store.acknowledge(input.clientOperationId, result, turnId),
      );
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
      if (
        dispatched &&
        !uncertain &&
        kind === 'action.resolve' &&
        this.projection.actions.get(target)?.status === 'responding'
      ) {
        const action = this.projection.resolveAction(target, 'pending');
        if (action?.threadId) this.publishThread(action.threadId);
      }
      if (kind === 'turn.start')
        this.capacityRetries.dispatchFailed(target, input.clientOperationId);
      if (dispatched && kind === 'turn.start') this.publishThread(target);
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
      if (kind === 'thread.compact') this.publishThread(target);
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
    if (!marker.turnId || !this.codex.ready) return;
    const existing = this.executionReads.get(marker.operationId);
    if (existing) return existing;
    const epoch = this.codex.epoch;
    const revision = this.projection.revision(marker.threadId);
    const reading = (async () => {
      try {
        const actual = await this.codex.readThread(marker.threadId);
        const latest = this.store.activeForThread(marker.threadId);
        // A delayed read cannot release a replacement execution or overwrite newer live events.
        if (
          !this.codex.ready ||
          this.codex.epoch !== epoch ||
          actual.id !== marker.threadId ||
          latest?.operationId !== marker.operationId ||
          latest.turnId !== marker.turnId ||
          latest.codexEpoch !== marker.codexEpoch ||
          this.projection.revision(marker.threadId) !== revision
        )
          return;
        const link = this.store.getThreadLink(marker.threadId);
        const ownership = link
          ? this.workspaces.assertOwnership(link.projectId, actual.cwd, actual.id)
          : this.workspaces.findOwner(actual.cwd, actual.id);
        if (ownership.workspaceKey !== marker.workspaceKey) return;
        const turn = actual.turns.find((entry) => entry.id === marker.turnId);
        if (
          turn &&
          isActive(turn.status) &&
          latest.state === 'active' &&
          this.projection.get(marker.threadId)?.status === 'unknown'
        ) {
          // A notLoaded status can hide an active managed turn. Restore its live controls
          // only after the same identity, runtime and revision checks used for completion.
          this.projection.thread(this.normalize(actual));
          this.publishThread(marker.threadId);
          return;
        }
        if (
          !turn ||
          !isTerminal(turn.status) ||
          isActive(actual.status) ||
          actual.turns.some((entry) => isActive(entry.status))
        )
          return;
        this.store.finishTurn(marker.threadId, turn.id, marker.codexEpoch);
        this.projection.thread(this.normalize(actual));
        this.projection.expireTurn(marker.threadId, turn.id);
        this.publishThread(marker.threadId);
        this.events.publish('operation', this.getOperation(marker.operationId), marker.threadId);
      } catch {
        // Missing/unavailable history is not terminal evidence. Keep the durable reservation.
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
      if (!('answers' in resolution)) throw new AppError('VALIDATION_ERROR', '请按问题提交答案');
      const questions = action.questions ?? [];
      if (
        Object.keys(resolution.answers).some(
          (id) => !questions.some((question) => question.id === id),
        )
      )
        throw new AppError('VALIDATION_ERROR', '回答包含未知问题');
      for (const question of questions) {
        const answers = resolution.answers[question.id];
        if (
          !answers?.length ||
          answers.some(
            (answer) =>
              !answer.trim() ||
              (!question.isOther &&
                question.options.length > 0 &&
                !question.options.some((option) => option.label === answer)),
          )
        )
          throw new AppError('VALIDATION_ERROR', `问题 ${question.header} 的回答不符合选项要求`);
      }
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
      ...(row.result === null ? {} : { result: row.result }),
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

  private publishThread(threadId: string): void {
    const thread = this.projection.get(threadId);
    if (!thread) return;
    const view = this.threadView(thread);
    this.events.publish('thread', view, threadId);
    const summary = toThreadSummary(view);
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

  private threadView(thread: ThreadView): ThreadView {
    const result = structuredClone(thread);
    // Most threads have no empty-input continuation, so defer the operation-history lookup.
    const links =
      this.capacityLinks.get(thread.id) ??
      (thread.turns.some((turn) => !turn.items.some((item) => item.type === 'userMessage'))
        ? this.retryLinks(thread.id)
        : undefined);
    for (const turn of result.turns) {
      const root = links?.get(turn.id);
      if (root) turn.retryOf = root;
    }
    const retry = this.capacityRetries.view(thread.id);
    if (retry) result.capacityRetry = structuredClone(retry);
    else delete result.capacityRetry;
    if (this.capacityRetries.pending(thread.id)) result.status = 'running';
    result.archived = thread.archived ?? false;
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
      this.compatibilityConfirmation(event.diagnostics);
      if (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.currentEpoch) {
        this.currentEpoch = event.diagnostics.codexEpoch;
        this.titleReads.clear();
        this.runtimeSettingsUpdates.clear();
        this.turnBaselines.clear();
        this.resumes.clear();
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
      const previous = new Set(owner ? pendingAttention(owner).map(attentionKey) : []);
      this.projection.action(action);
      if (action.threadId) {
        this.publishThread(action.threadId);
        if (!known) this.publishNewAttention(action.threadId, previous);
      }
      return;
    }
    if (event.type === 'actionResolved') {
      const action = this.projection.resolveAction(event.actionId, 'responded');
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
    const previousAttention = new Set(
      event.type === 'item' || event.type === 'turn'
        ? pendingAttention(thread).map(attentionKey)
        : [],
    );
    if (event.type === 'compactionCompleted') {
      if (this.projection.compactionCompleted(thread.id, event.turnId))
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
    this.publishThread(thread.id);
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

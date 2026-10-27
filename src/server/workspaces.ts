import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { AppError } from '../shared/errors.js';
import type { AppDatabase } from './db/index.js';
import { operations, sessionWorkspaces } from './db/schema.js';
import { containsPath, ProjectRegistry } from './projects.js';

type Allocation = typeof sessionWorkspaces.$inferSelect;
export interface WorkspaceOwnership {
  projectId: string | null;
  cwd: string;
  rootPath: string;
  canonicalRoot: string;
  workspaceKey: string;
}

/** A project association and a server-owned session directory are separate identities. */
export class WorkspaceRegistry {
  constructor(
    private readonly database: AppDatabase,
    private readonly projects: ProjectRegistry,
    private readonly root?: string,
  ) {}

  private unavailable(cause?: unknown): AppError {
    return new AppError(
      'WORKSPACE_UNAVAILABLE',
      cause instanceof Error ? `会话工作目录不可用：${cause.message}` : '会话工作目录不可用',
      409,
    );
  }

  defaultsDirectory(): string {
    if (!this.root) throw this.unavailable();
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const root = realpathSync(this.root);
      accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
      return root;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  allocations(): Allocation[] {
    return this.database.select().from(sessionWorkspaces).all();
  }

  /** A dedicated directory lets us identify a creation whose RPC receipt was lost. */
  recoverCreation(threadId: string, cwd: string): string | undefined {
    const canonical = realpathSync(cwd);
    const row = this.allocations().find((entry) => entry.canonicalRoot === canonical);
    if (!row || (row.threadId !== null && row.threadId !== threadId)) return;
    const operation = this.database
      .select()
      .from(operations)
      .where(eq(operations.clientOperationId, row.operationId))
      .get();
    if (
      operation?.state !== 'unknown' ||
      !['thread.create', 'thread.fork'].includes(operation.kind)
    )
      return;
    this.bind(row.operationId, threadId, cwd);
    return row.operationId;
  }

  private inspect(row: Allocation): WorkspaceOwnership {
    try {
      if (
        realpathSync(row.rootPath) !== row.canonicalRoot ||
        !statSync(row.canonicalRoot).isDirectory()
      )
        throw new Error('目录不存在或真实路径已改变');
      accessSync(row.canonicalRoot, constants.R_OK | constants.X_OK);
      return {
        projectId: null,
        cwd: row.canonicalRoot,
        rootPath: row.rootPath,
        canonicalRoot: row.canonicalRoot,
        workspaceKey: row.canonicalRoot,
      };
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  draft(operationId: string): WorkspaceOwnership {
    const scope = this.allocate(operationId);
    const row = this.allocations().find((entry) => entry.operationId === operationId);
    if (row?.threadId) throw this.unavailable();
    return scope;
  }

  allocate(operationId: string): WorkspaceOwnership {
    const existing = this.database
      .select()
      .from(sessionWorkspaces)
      .where(eq(sessionWorkspaces.operationId, operationId))
      .get();
    if (existing) return this.inspect(existing);
    const root = this.defaultsDirectory();
    const rootPath = join(root, operationId);
    try {
      // Never reuse an unrecorded directory, including one left by a crashed mkdir.
      mkdirSync(rootPath, { mode: 0o700 });
      const row = {
        operationId,
        threadId: null,
        rootPath,
        canonicalRoot: realpathSync(rootPath),
        createdAt: Date.now(),
      };
      this.database.insert(sessionWorkspaces).values(row).run();
      return this.inspect(row);
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  bind(operationId: string, threadId: string, cwd: string): void {
    const row = this.database
      .select()
      .from(sessionWorkspaces)
      .where(eq(sessionWorkspaces.operationId, operationId))
      .get();
    if (!row || (row.threadId !== null && row.threadId !== threadId)) throw this.unavailable();
    const scope = this.inspect(row);
    if (realpathSync(cwd) !== scope.cwd) throw this.unavailable();
    this.database
      .update(sessionWorkspaces)
      .set({ threadId })
      .where(eq(sessionWorkspaces.operationId, operationId))
      .run();
  }

  assertOwnership(projectId: string | null, cwd: string, threadId: string): WorkspaceOwnership {
    if (projectId !== null) {
      const ownership = this.projects.assertOwnership(projectId, cwd);
      this.assertOutsideManaged(ownership.cwd);
      return {
        ...ownership,
        projectId,
        rootPath: ownership.project.rootPath,
        canonicalRoot: ownership.project.canonicalRoot,
      };
    }
    const row = this.database
      .select()
      .from(sessionWorkspaces)
      .where(eq(sessionWorkspaces.threadId, threadId))
      .get();
    if (!row) throw new AppError('PROJECT_OWNERSHIP', '会话没有已分配的工作目录', 403);
    const scope = this.inspect(row);
    if (realpathSync(cwd) !== scope.cwd)
      throw new AppError('PROJECT_OWNERSHIP', '会话工作目录与已保存的关联不一致', 403);
    return scope;
  }

  assertProjectDirectory(cwd: string): void {
    let canonical: string;
    try {
      canonical = realpathSync(cwd);
    } catch {
      try {
        // Clone destinations may not exist yet; their parent must already exist.
        canonical = join(realpathSync(dirname(cwd)), basename(cwd));
      } catch {
        return;
      }
    }
    this.assertOutsideManaged(canonical);
  }

  private assertOutsideManaged(cwd: string): void {
    let root = this.root;
    try {
      if (root) root = realpathSync(root);
    } catch {
      /* A missing root has no files to adopt. */
    }
    if (
      (root && containsPath(root, cwd)) ||
      this.allocations().some((row) => containsPath(row.canonicalRoot, cwd))
    )
      throw new AppError('PROJECT_OWNERSHIP', '应用管理的会话目录不能归入项目', 403);
  }

  findOwner(cwd: string, threadId: string): WorkspaceOwnership {
    const row = this.database
      .select()
      .from(sessionWorkspaces)
      .where(eq(sessionWorkspaces.threadId, threadId))
      .get();
    if (row) return this.assertOwnership(null, cwd, threadId);
    this.assertOutsideManaged(realpathSync(cwd));
    const ownership = this.projects.findOwner(cwd);
    return this.assertOwnership(ownership.project.id, cwd, threadId);
  }
}

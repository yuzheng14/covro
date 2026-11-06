import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../shared/errors.js';
import type {
  CreateProjectInput,
  Project,
  RenameProjectInput,
  ReorderProjectsInput,
} from '../shared/types.js';
import {
  createProjectSchema,
  renameProjectSchema,
  reorderProjectsSchema,
} from '../shared/validation.js';
import type { AppDatabase } from './db/index.js';
import { projectRegistrations } from './db/schema.js';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
}
type Registration = typeof projectRegistrations.$inferSelect;

export function containsPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function checkoutRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output ? realpathSync(output) : undefined;
  } catch {
    return undefined;
  }
}

export class ProjectRegistry {
  private readonly registered = new Map<string, Registration>();

  constructor(
    configs: ProjectConfig[],
    private readonly database?: AppDatabase,
  ) {
    for (const row of database
      ?.select()
      .from(projectRegistrations)
      .orderBy(
        asc(projectRegistrations.sortOrder),
        asc(projectRegistrations.createdAt),
        asc(projectRegistrations.id),
      )
      .all() ?? [])
      this.registered.set(row.id, row);
    // JSON remains a source of new registrations, while persisted UI decisions win.
    // Keep legacy aliases and IDs intact; only new UI registrations reject aliases.
    const seeds: Registration[] = [];
    for (const config of configs) {
      const path = resolve(config.path);
      const existing = this.registered.get(config.id);
      if (existing) {
        if (existing.path !== path)
          throw new AppError(
            'PROJECT_ID_CONFLICT',
            `项目 ${config.id} 已绑定其他目录；项目 ID 和目录不可修改，请使用新 ID`,
            409,
            { projectId: config.id },
          );
        continue;
      }
      let canonicalRoot: string | null = null;
      try {
        canonicalRoot = this.directory(path);
      } catch {
        // Existing configurations with temporarily missing directories still start.
      }
      const now = this.nextCreatedAt();
      const row = {
        ...config,
        path,
        canonicalRoot,
        removedAt: null,
        sortOrder: this.nextSortOrder(),
        createdAt: now,
        updatedAt: now,
      };
      this.registered.set(config.id, row);
      seeds.push(row);
    }
    if (seeds.length) database?.insert(projectRegistrations).values(seeds).run();
  }

  private nextCreatedAt(): number {
    // Preserve seed order for legacy aliases even when imported within one millisecond.
    return [...this.registered.values()].reduce(
      (next, row) => Math.max(next, row.createdAt + 1),
      Date.now(),
    );
  }

  private nextSortOrder(): number {
    return [...this.registered.values()].reduce(
      (next, row) => Math.max(next, row.sortOrder + 1),
      0,
    );
  }

  private directory(path: string): string {
    if (!isAbsolute(path) || path.includes('\0'))
      throw new AppError('INVALID_PROJECT_PATH', '请输入运行 Codex 的电脑上的绝对目录路径', 400);
    try {
      const canonicalRoot = realpathSync(path);
      if (!statSync(canonicalRoot).isDirectory())
        throw new AppError('PROJECT_UNAVAILABLE', '项目路径不是目录', 409);
      accessSync(canonicalRoot, constants.R_OK | constants.X_OK);
      return canonicalRoot;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new AppError(
        'PROJECT_UNAVAILABLE',
        code === 'ENOENT' || code === 'ENOTDIR'
          ? '项目目录不存在；请输入运行 Codex 的电脑上的目录'
          : code === 'EACCES' || code === 'EPERM'
            ? '项目目录不可访问，需要读取和进入目录的权限'
            : '项目目录不可用，请检查路径和访问权限',
        409,
      );
    }
  }

  private save(row: Registration): void {
    this.database
      ?.insert(projectRegistrations)
      .values(row)
      .onConflictDoUpdate({ target: projectRegistrations.id, set: row })
      .run();
    this.registered.set(row.id, row);
  }

  private registration(id: string): Registration {
    const row = this.registered.get(id);
    if (!row || row.removedAt !== null)
      throw new AppError('PROJECT_NOT_FOUND', '项目未注册或已移除', 404);
    return row;
  }

  private inspect(config: Registration): Project {
    const rootPath = config.path;
    try {
      const canonicalRoot = this.directory(rootPath);
      if (config.canonicalRoot !== null && canonicalRoot !== config.canonicalRoot)
        throw new AppError(
          'PROJECT_UNAVAILABLE',
          '项目目录的真实路径已改变，不能沿用原项目身份',
          409,
        );
      if (config.canonicalRoot === null)
        this.save({ ...config, canonicalRoot, updatedAt: Date.now() });
      return {
        id: config.id,
        name: config.name,
        rootPath,
        canonicalRoot,
        workspaceKey: checkoutRoot(canonicalRoot) ?? canonicalRoot,
        available: true,
      };
    } catch (error) {
      return {
        id: config.id,
        name: config.name,
        rootPath,
        canonicalRoot: config.canonicalRoot ?? rootPath,
        workspaceKey: config.canonicalRoot ?? rootPath,
        available: false,
        error: error instanceof Error ? error.message : '项目不可用',
      };
    }
  }

  list(): Project[] {
    return [...this.registered.values()]
      .filter((project) => project.removedAt === null)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      )
      .map((project) => this.inspect(project));
  }

  reorder(input: ReorderProjectsInput): Project[] {
    const { projectIds } = reorderProjectsSchema.parse(input);
    const active = [...this.registered.values()].filter((row) => row.removedAt === null);
    if (
      projectIds.length !== active.length ||
      projectIds.some(
        (id) => !this.registered.has(id) || this.registered.get(id)!.removedAt !== null,
      )
    )
      throw new AppError('PROJECT_ORDER_CONFLICT', '项目列表已变化，请刷新后重新调整顺序', 409);
    const now = Date.now();
    const rows = projectIds.map((id, sortOrder) => ({
      ...this.registration(id),
      sortOrder,
      updatedAt: now,
    }));
    // Commit the complete order atomically, then update memory only after success.
    this.database?.transaction((tx) => {
      for (const row of rows)
        tx.update(projectRegistrations)
          .set({ sortOrder: row.sortOrder, updatedAt: now })
          .where(eq(projectRegistrations.id, row.id))
          .run();
    });
    for (const row of rows) this.registered.set(row.id, row);
    return this.list();
  }

  /** Also usable when a saved directory is missing, so it can still be managed. */
  describe(id: string): Project {
    return this.inspect(this.registration(id));
  }

  add(input: CreateProjectInput): Project {
    const parsed = createProjectSchema.parse(input);
    const canonicalRoot = this.directory(parsed.path);
    // Inspect lazily imported paths before checking, including legacy unavailable seeds.
    this.list();
    for (const row of this.registered.values()) {
      if (row.canonicalRoot !== null || row.removedAt === null) continue;
      try {
        this.save({ ...row, canonicalRoot: this.directory(row.path), updatedAt: Date.now() });
      } catch {
        // A tombstone still reserves its ID while its directory remains unavailable.
      }
    }
    const matching = [...this.registered.values()].filter(
      (row) => row.canonicalRoot === canonicalRoot,
    );
    const removed = matching.find((row) => row.removedAt !== null);
    const now = Date.now();
    if (removed) {
      // Restoring a grandfathered alias reuses an existing identity; it does not
      // create a duplicate registration even when another legacy alias is active.
      // A spelling/alias supplied during restoration does not change saved identity.
      const restored = {
        ...removed,
        removedAt: null,
        sortOrder: this.nextSortOrder(),
        updatedAt: now,
      };
      const project = this.inspect(restored);
      if (!project.available)
        throw new AppError('PROJECT_UNAVAILABLE', project.error ?? '原项目目录不可用', 409);
      this.save({ ...restored, name: parsed.name ?? removed.name });
      return this.get(removed.id);
    }
    const existing = matching[0];
    if (existing)
      throw new AppError('PROJECT_EXISTS', '该目录已添加，请选择已有项目', 409, {
        projectId: existing.id,
      });
    const row: Registration = {
      id: randomUUID(),
      name: parsed.name ?? (basename(canonicalRoot) || canonicalRoot),
      path: canonicalRoot,
      canonicalRoot,
      removedAt: null,
      sortOrder: this.nextSortOrder(),
      createdAt: this.nextCreatedAt(),
      updatedAt: now,
    };
    this.save(row);
    return this.get(row.id);
  }

  rename(id: string, input: RenameProjectInput): Project {
    const { name } = renameProjectSchema.parse(input);
    this.save({ ...this.registration(id), name, updatedAt: Date.now() });
    return this.describe(id);
  }

  remove(id: string): void {
    const now = Date.now();
    this.save({ ...this.registration(id), removedAt: now, updatedAt: now });
  }

  get(id: string): Project {
    const project = this.describe(id);
    if (!project.available)
      throw new AppError('PROJECT_UNAVAILABLE', '项目目录不可用', 409, { projectId: id });
    return project;
  }

  /** Nested registrations, including tombstones, retain their own file boundary. */
  referenceRoots(): string[] {
    return [...this.registered.values()].map(
      (row) => row.canonicalRoot ?? this.inspect(row).canonicalRoot,
    );
  }

  assertOwnership(
    projectId: string,
    cwd: string,
  ): { project: Project; cwd: string; workspaceKey: string } {
    const project = this.get(projectId);
    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
      if (!statSync(canonicalCwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError('PROJECT_UNAVAILABLE', '会话工作目录不可用', 409);
    }
    if (!containsPath(project.canonicalRoot, canonicalCwd))
      throw new AppError('PROJECT_OWNERSHIP', '会话不属于所选项目目录', 403);
    return {
      project,
      cwd: canonicalCwd,
      workspaceKey: checkoutRoot(canonicalCwd) ?? project.canonicalRoot,
    };
  }

  findOwner(cwd: string): { project: Project; cwd: string; workspaceKey: string } {
    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
    } catch {
      throw new AppError('PROJECT_UNAVAILABLE', '会话目录不可用', 409);
    }
    // Tombstones reserve automatic ownership as well: a parent must not adopt
    // previously undiscovered history from a removed nested project.
    // An active grandfathered alias at the same root remains eligible; only a
    // deeper tombstone reserves history against a different, shallower directory.
    const project = [...this.registered.values()]
      .map((entry) => ({ project: this.inspect(entry), removed: entry.removedAt !== null }))
      .filter((entry) => containsPath(entry.project.canonicalRoot, canonicalCwd))
      .sort(
        (a, b) =>
          b.project.canonicalRoot.length - a.project.canonicalRoot.length ||
          Number(a.removed) - Number(b.removed),
      )[0]?.project;
    if (!project) throw new AppError('PROJECT_OWNERSHIP', '会话不属于已注册项目', 403);
    return this.assertOwnership(project.id, canonicalCwd);
  }
}

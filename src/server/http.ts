import type { BackupController } from '../shared/backups.js';
import { backupIdSchema } from '../shared/backups.js';
import { backupRequestSchema } from '../backups/manager.js';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { upgradeWebSocket, type HttpBindings } from '@hono/node-server';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';
import { IMAGE_REQUEST_BYTES } from '../shared/images.js';
import * as schemas from '../shared/validation.js';
import type { Operation } from '../shared/types.js';
import type { AppConfig } from './config.js';
import { ConfigStore } from './config-store.js';
import { projectPathPreview, resolveProjectPath } from './project-paths.js';
import { createAuthenticator, type Authenticator, type Identity } from './auth.js';
import type { GatewayService } from './service.js';
import { socketHandlers } from './websocket.js';
import { z } from 'zod';
import { releaseChannels, type UpdateController } from '../shared/updates.js';
import { settingsSchema, updateRequestSchema } from '../updates/manager.js';
import { createReleaseNotesLookup, releaseNotesQuery } from '../updates/release-notes.js';
import { startShellSchema } from '../shared/shell.js';
export interface HttpDependencies {
  config: AppConfig;
  service: GatewayService;
  staticDir: string;
  authenticate?: Authenticator;
  updates?: UpdateController;
  backups?: BackupController;
}
export function createApp({
  config,
  service,
  staticDir,
  authenticate = createAuthenticator(config),
  updates,
  backups,
}: HttpDependencies) {
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { identity: Identity; operationId?: string };
  }>();
  app.onError((error, c) => {
    const failure =
      error instanceof AppError
        ? error
        : error instanceof ZodError || error instanceof SyntaxError
          ? new AppError('VALIDATION_FAILED', 'Invalid request data', 400)
          : new AppError('INTERNAL_ERROR', 'An internal error occurred', 500);
    return c.json({ error: failure.toJSON(c.get('operationId')) }, failure.status as 400);
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('*', async (c, next) => {
    c.set('identity', await authenticate(c.req.raw, c.req.path === '/ws'));
    await next();
  });
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize: /^\/api\/threads\/[^/]+\/(turns|steer)$/.test(c.req.path)
        ? IMAGE_REQUEST_BYTES
        : 512 * 1024,
      onError: () => {
        throw new AppError('BODY_TOO_LARGE', 'Request body exceeds limit', 413);
      },
    })(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (
      service.isInMaintenance() &&
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !c.req.path.startsWith('/api/updates') &&
      !c.req.path.startsWith('/api/backups')
    )
      throw service.maintenanceError();
    await next();
  });
  if (backups) {
    app.get('/api/backups', async (c) => c.json(await backups.status()));
    app.post('/api/backups', async (c) =>
      c.json(await backups.start(backupRequestSchema.parse(await c.req.json())), 202),
    );
    app.post('/api/backups/:id/cancel', async (c) =>
      c.json(await backups.cancel(backupIdSchema.parse(c.req.param('id')))),
    );
    app.post('/api/backups/:id/verify', async (c) =>
      c.json(await backups.verify(backupIdSchema.parse(c.req.param('id')))),
    );
  }
  if (updates) {
    const releaseNotes = createReleaseNotesLookup();
    app.get('/api/updates/release-notes', async (c) => {
      const { version, refresh } = releaseNotesQuery.parse(c.req.query());
      return c.json(await releaseNotes(version, refresh === '1'));
    });
    app.get('/api/updates', async (c) => c.json(await updates.status()));
    app.post('/api/updates/check', async (c) => {
      const input = z
        .object({ channel: z.enum(releaseChannels).optional() })
        .strict()
        .parse(await c.req.json());
      return c.json(await updates.check(input.channel));
    });
    app.post('/api/updates/settings', async (c) =>
      c.json(await updates.configure(settingsSchema.parse(await c.req.json()))),
    );
    app.post('/api/updates/run', async (c) =>
      c.json(await updates.start(updateRequestSchema.parse(await c.req.json())), 202),
    );
  }
  const id = (value: string) => schemas.idSchema.parse(value);
  const parse = async <T>(
    c: { req: { json: () => Promise<unknown> }; set: (key: 'operationId', value: string) => void },
    schema: ZodType<T>,
  ): Promise<T> => {
    const value: unknown = await c.req.json();
    if (
      value &&
      typeof value === 'object' &&
      'clientOperationId' in value &&
      typeof value.clientOperationId === 'string'
    )
      c.set('operationId', value.clientOperationId);
    return schema.parse(value);
  };
  const status = (op: Operation) =>
    op.status === 'dispatching' || op.status === 'accepted' ? (202 as const) : (200 as const);
  const configuration = new ConfigStore(config);
  app.get('/api/project-path', (c) => {
    const input = z
      .object({
        path: z.string().max(4096).default(''),
        directory: z
          .string()
          .max(255)
          .refine((value) => !/[\\/\0]/.test(value) && value !== '.' && value !== '..')
          .optional(),
      })
      .parse({ path: c.req.query('path'), directory: c.req.query('directory') });
    return c.json(projectPathPreview(input.path.trim(), configuration.workDir, input.directory));
  });
  app.use('/api/config*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/config', async (c) => c.json(await configuration.snapshot()));
  app.post('/api/config', async (c) => c.json(await configuration.save(await c.req.json())));
  app.post('/api/config/import', async (c) =>
    c.json(await configuration.previewImport(await c.req.json())),
  );
  app.get('/api/config/export', async (c) => {
    c.header('Content-Disposition', 'attachment; filename="codex-web-config.json"');
    return c.json(await configuration.export());
  });
  app.get('/api/history-cache-context', async (c) => {
    const identity = c.get('identity');
    if (config.auth.mode !== 'local' && !identity.subject)
      throw new AppError('UNAUTHENTICATED', '无法确认缓存所属用户', 401);
    const projects = await service.listProjects();
    // A restart, user change or project/permission change creates a new namespace.
    // The subject is hashed on the server and is never exposed to browser storage.
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          service.events.serverEpoch,
          service.getSystem().codexEpoch,
          config.auth.mode,
          identity.subject ?? 'local',
          projects.map((project) => [project.id, project.rootPath, project.available]),
        ]),
      )
      .digest('hex');
    return c.json({ scope });
  });
  app.post('/api/skills/list', async (c) =>
    c.json(await service.listSkills(schemas.skillsQuerySchema.parse(await c.req.json()))),
  );
  app.get('/api/system', (c) => c.json(service.getSystem()));
  app.get('/api/account/usage', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await service.refreshAccountUsage());
  });
  app.get('/api/shell', (c) =>
    c.json(
      service.shell.snapshot(
        c.req.query('epoch'),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .default(0)
          .parse(c.req.query('after')),
      ),
    ),
  );
  app.post('/api/projects/:projectId/shell', async (c) => {
    const op = await service.startShell(
      id(c.req.param('projectId')),
      await parse(c, startShellSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/shell/:commandId/interrupt', async (c) => {
    const op = await service.interruptShell(
      id(c.req.param('commandId')),
      await parse(c, schemas.operationSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/system/compatibility/confirm', async (c) => {
    const op = await service.confirmCompatibility(
      await parse(c, schemas.confirmCompatibilitySchema),
    );
    return c.json(op, status(op));
  });
  app.get('/api/projects', async (c) => c.json({ data: await service.listProjects() }));
  app.get('/api/projects/:projectId/diff', async (c) =>
    c.json(await service.getProjectDiff(id(c.req.param('projectId')))),
  );
  app.get('/api/threads/:threadId/diff', async (c) =>
    c.json(await service.getThreadDiff(id(c.req.param('threadId')))),
  );
  app.get('/api/projects/:projectId/github-repository', async (c) =>
    c.json(await service.getProjectGithubRepository(id(c.req.param('projectId')))),
  );
  app.get('/api/threads/:threadId/github-repository', async (c) =>
    c.json(await service.getThreadGithubRepository(id(c.req.param('threadId')))),
  );
  app.get('/api/unassigned/runtime-settings', async (c) =>
    c.json(await service.readRuntimeSettings(null)),
  );
  app.post('/api/unassigned/model-defaults', async (c) => {
    const op = await service.saveModelDefaults(
      null,
      await parse(c, schemas.saveModelDefaultsSchema),
    );
    return c.json(op, status(op));
  });
  app.get('/api/unassigned/threads', async (c) =>
    c.json(
      await service.listThreadSummaries(
        null,
        c.req.query('cursor') === undefined
          ? undefined
          : schemas.cursorSchema.parse(c.req.query('cursor')),
        schemas.archivedQuerySchema.parse(c.req.query('archived')),
      ),
    ),
  );
  app.post('/api/unassigned/threads', async (c) => {
    const op = await service.createThread(null, await parse(c, schemas.createThreadSchema));
    return c.json(op, status(op));
  });
  app.post('/api/project-clones', async (c) =>
    c.json(
      service.cloneProject(await parse(c, schemas.cloneProjectSchema), (path) =>
        resolveProjectPath(path, configuration.workDir),
      ),
      202,
    ),
  );
  app.get('/api/project-clones/:cloneId', (c) =>
    c.json(service.projectClones.get(id(c.req.param('cloneId')))),
  );
  app.post('/api/project-clones/:cloneId/cancel', async (c) => {
    await parse(c, schemas.removeProjectSchema);
    return c.json(service.projectClones.cancel(id(c.req.param('cloneId'))));
  });
  app.post('/api/project-clones/:cloneId/register', async (c) => {
    await parse(c, schemas.removeProjectSchema);
    return c.json(service.projectClones.retryRegistration(id(c.req.param('cloneId'))));
  });
  app.post('/api/projects/reorder', async (c) =>
    c.json(service.reorderProjects(await parse(c, schemas.reorderProjectsSchema))),
  );
  app.get('/api/projects/:projectId/runtime-settings', async (c) =>
    c.json(await service.readRuntimeSettings(id(c.req.param('projectId')))),
  );
  app.post('/api/projects/:projectId/model-defaults', async (c) => {
    const op = await service.saveModelDefaults(
      id(c.req.param('projectId')),
      await parse(c, schemas.saveModelDefaultsSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/projects', async (c) => {
    const input = await parse(c, schemas.createProjectSchema);
    return c.json(
      service.addProject({ ...input, path: resolveProjectPath(input.path, configuration.workDir) }),
    );
  });
  app.post('/api/projects/:projectId/rename', async (c) =>
    c.json(
      service.renameProject(
        id(c.req.param('projectId')),
        await parse(c, schemas.renameProjectSchema),
      ),
    ),
  );
  app.post('/api/projects/:projectId/remove', async (c) => {
    await parse(c, schemas.removeProjectSchema);
    return c.json(service.removeProject(id(c.req.param('projectId'))));
  });
  app.get('/api/projects/:projectId/threads', async (c) =>
    c.json(
      await service.listThreadSummaries(
        id(c.req.param('projectId')),
        c.req.query('cursor') === undefined
          ? undefined
          : schemas.cursorSchema.parse(c.req.query('cursor')),
        schemas.archivedQuerySchema.parse(c.req.query('archived')),
      ),
    ),
  );
  app.get('/api/threads', async (c) =>
    c.json(
      await service.listThreads(
        id(c.req.query('projectId') ?? ''),
        c.req.query('cursor') === undefined
          ? undefined
          : schemas.cursorSchema.parse(c.req.query('cursor')),
        schemas.archivedQuerySchema.parse(c.req.query('archived')),
      ),
    ),
  );
  app.post('/api/threads/:threadId/archive', async (c) => {
    return c.json(
      await service.setThreadArchived(
        id(c.req.param('threadId')),
        await parse(c, schemas.archiveThreadSchema),
      ),
    );
  });
  app.get('/api/threads/:threadId', async (c) =>
    c.json(await service.getThread(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/history', async (c) =>
    c.json(await service.getThreadHistory(id(c.req.param('threadId')), c.req.query('cursor'))),
  );
  app.get('/api/threads/:threadId/snapshot', async (c) =>
    c.json(await service.getThreadSnapshot(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/attention', (c) =>
    c.json(service.getThreadAttention(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/metadata', async (c) =>
    c.json(await service.getThreadMetadata(id(c.req.param('threadId')))),
  );
  app.get('/api/threads/:threadId/export', async (c) => {
    const exported = await service.exportThread(id(c.req.param('threadId')));
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Export-Completeness', exported.partial ? 'partial' : 'saved-history');
    return c.body(exported.markdown);
  });
  app.get('/api/threads/:threadId/images', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    const image = await service.getThreadImage(id(c.req.param('threadId')), c.req.query('path'));
    // Hash the validated bytes so same-size overwrites with preserved mtimes also invalidate.
    const etag = `"${createHash('sha256').update(image.bytes).digest('hex')}"`;
    c.header('Cache-Control', 'private, no-cache');
    c.header('ETag', etag);
    const ifNoneMatch = c.req.header('If-None-Match');
    if (
      ifNoneMatch === '*' ||
      ifNoneMatch?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
    )
      return c.body(null, 304);
    return c.body(image.bytes, 200, {
      'Content-Type': image.contentType,
      'Content-Length': String(image.bytes.length),
    });
  });
  app.get('/api/threads/:threadId/markdown', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.json(
      await service.getThreadMarkdown(id(c.req.param('threadId')), c.req.query('path')),
    );
  });
  app.get('/api/threads/:threadId/text', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.json(await service.getThreadText(id(c.req.param('threadId')), c.req.query('path')));
  });
  app.get('/api/threads/:threadId/json', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.json(await service.getThreadJson(id(c.req.param('threadId')), c.req.query('path')));
  });
  app.get('/api/operations/:operationId', (c) =>
    c.json(service.getOperation(id(c.req.param('operationId')))),
  );
  app.post('/api/projects/:projectId/threads', async (c) => {
    const op = await service.createThread(
      id(c.req.param('projectId')),
      await parse(c, schemas.createThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/resume', async (c) => {
    const op = await service.resumeThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.resumeThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/fork', async (c) => {
    const op = await service.forkThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.forkThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/rename', async (c) => {
    const op = await service.renameThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.renameThreadSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/live-settings', async (c) => {
    const op = await service.updateLiveSettings(
      id(c.req.param('threadId')),
      await parse(c, schemas.updateLiveSettingsSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/turns', async (c) => {
    const op = await service.startTurn(
      id(c.req.param('threadId')),
      await parse(c, schemas.startTurnSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/retry', async (c) => {
    const op = await service.retryTurn(
      id(c.req.param('threadId')),
      await parse(c, schemas.retryTurnSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/retry/cancel', async (c) => {
    const op = await service.cancelCapacityRetry(
      id(c.req.param('threadId')),
      await parse(c, schemas.interruptSchema),
    );
    return c.json(op, status(op));
  });
  app.get('/api/threads/:threadId/goal', async (c) =>
    c.json(await service.getGoal(id(c.req.param('threadId')))),
  );
  app.post('/api/threads/:threadId/goal', async (c) => {
    const op = await service.mutateGoal(
      id(c.req.param('threadId')),
      await parse(c, schemas.goalMutationSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/recap', async (c) => {
    const op = await service.recapThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.recapSchema),
    );
    return c.json(op, status(op));
  });
  app.get('/api/threads/:threadId/denials', async (c) =>
    c.json(await service.getGuardianDenials(id(c.req.param('threadId')))),
  );
  app.post('/api/threads/:threadId/approve', async (c) => {
    const op = await service.approveGuardianDenial(
      id(c.req.param('threadId')),
      await parse(c, schemas.approveDenialSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/review', async (c) => {
    const op = await service.startReview(
      id(c.req.param('threadId')),
      await parse(c, schemas.startReviewSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/steer', async (c) => {
    const op = await service.steer(
      id(c.req.param('threadId')),
      await parse(c, schemas.steerSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/compact', async (c) => {
    const op = await service.compactThread(
      id(c.req.param('threadId')),
      await parse(c, schemas.operationSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/threads/:threadId/interrupt', async (c) => {
    const op = await service.interrupt(
      id(c.req.param('threadId')),
      await parse(c, schemas.interruptSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/actions/:actionId/resolve', async (c) => {
    const op = await service.resolveAction(
      id(c.req.param('actionId')),
      await parse(c, schemas.resolveActionSchema),
    );
    return c.json(op, status(op));
  });
  app.post('/api/operations/:operationId/reconcile', async (c) => {
    const op = await service.reconcileOperation(
      id(c.req.param('operationId')),
      await parse(c, schemas.reconcileSchema),
    );
    return c.json(op, status(op));
  });
  app.get(
    '/ws',
    upgradeWebSocket((c) =>
      socketHandlers(service, config, c.get('identity'), c.req.query('overview') === '1'),
    ),
  );
  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', 'API route not found', 404);
  });
  app.all('/api', () => {
    throw new AppError('NOT_FOUND', 'API route not found', 404);
  });
  app.all('/ws/*', () => {
    throw new AppError('NOT_FOUND', 'WebSocket route not found', 404);
  });
  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      // Remote Markdown images load directly in the browser, including HTTPS redirects.
      // Keep scripts, connections and all other resource policies restricted as before.
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    await next();
  });
  app.get('*', serveStatic({ root: staticDir }));
  app.get('*', async (c, next) => {
    if (!c.req.header('accept')?.includes('text/html') || /\.[^/]+$/.test(c.req.path))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404);
    return serveStatic({ path: `${staticDir}/index.html` })(c, next);
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404));
  return app;
}

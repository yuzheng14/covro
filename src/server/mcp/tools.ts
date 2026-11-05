import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { Operation } from '../../shared/types.js';
import { idSchema } from '../../shared/validation.js';
import type { GatewayService } from '../service.js';
import type { SessionCreationResult } from '../session-creation.js';

export const listProjectsInput = z.object({}).strict();
export const createSessionInput = z
  .object({
    project_id: idSchema.describe(
      'Project ID returned by list_projects. Check its path before creating the session.',
    ),
    prompt: z
      .string()
      .max(100_000)
      .refine((value) => Boolean(value.trim()), 'Prompt is required')
      .describe('Required initial user prompt. It is submitted immediately to the new session.'),
    request_key: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Reuse the same key for retries of one intended session. Returned on every response. Codex calls can omit this; their tool call ID supplies the key.',
      ),
  })
  .strict();

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function result(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function operationKey(meta: Record<string, unknown> | undefined): string {
  if (
    typeof meta?.callId !== 'string' ||
    !meta.callId ||
    typeof meta.threadId !== 'string' ||
    !meta.threadId
  )
    throw new AppError(
      'REQUEST_KEY_REQUIRED',
      'Supply request_key when the client does not provide Codex threadId and callId metadata',
    );
  const hash = createHash('sha256')
    .update(JSON.stringify(['covro.session.create', meta.threadId, meta.callId]))
    .digest('hex');
  // UUIDv8: a stable application-defined ID, independent of the app-server epoch.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function receipt(operation: Operation, origin: string): ToolResult {
  const saved = operation.result as SessionCreationResult | undefined;
  const value: Record<string, unknown> = {
    request_key: operation.clientOperationId,
    operation_id: operation.clientOperationId,
    status: operation.status,
    project_id: operation.target,
    ...(saved?.stage ? { stage: saved.stage } : {}),
    ...(saved?.threadId
      ? {
          thread_id: saved.threadId,
          url: new URL(
            `/#notification=${encodeURIComponent(JSON.stringify({ threadId: saved.threadId, projectId: operation.target }))}`,
            origin,
          ).href,
        }
      : {}),
    ...(saved?.turnId ? { turn_id: saved.turnId } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  };
  return result(value, operation.status === 'failed' || operation.status === 'unknown');
}

/** Protocol-neutral handlers; every mutation goes through the gateway's business services. */
export class CovroTools {
  constructor(
    private readonly service: GatewayService,
    private readonly origin: string,
  ) {}

  listProjects(input: unknown): ToolResult {
    listProjectsInput.parse(input);
    return result({
      projects: this.service.listProjects().map((project) => ({
        project_id: project.id,
        name: project.name,
        path: project.canonicalRoot,
        available: project.available,
        ...(project.error ? { error: project.error } : {}),
      })),
    });
  }

  async createSession(input: unknown, meta?: Record<string, unknown>): Promise<ToolResult> {
    const parsed = createSessionInput.parse(input);
    let key: string | undefined;
    try {
      key = parsed.request_key ?? operationKey(meta);
      const operation = await this.service.createSession(parsed.project_id, {
        clientOperationId: key,
        prompt: parsed.prompt,
      });
      return receipt(operation, this.origin);
    } catch (error) {
      if (key && error instanceof AppError && error.code !== 'OPERATION_CONFLICT') {
        try {
          const operation = this.service.getOperation(key);
          if (
            operation.kind === 'session.create' &&
            operation.target === parsed.project_id &&
            (operation.status === 'failed' || operation.status === 'unknown')
          )
            return receipt(operation, this.origin);
        } catch {
          /* Validation and shutdown failures may precede a persisted operation. */
        }
      }
      return result(
        {
          ...(key ? { request_key: key } : {}),
          error:
            error instanceof AppError
              ? error.toJSON()
              : { code: 'INTERNAL_ERROR', message: 'Unable to create the session' },
        },
        true,
      );
    }
  }
}

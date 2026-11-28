import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { withLogContext } from '../../logging/context.js';
import { errorFields } from '../../logging/fields.js';
import type { Logger } from '../../logging/logger.js';
import { AppError } from '../../shared/errors.js';
import type { Operation } from '../../shared/types.js';
import {
  LOOP_MAX_INTERVAL,
  LOOP_MAX_PROMPT,
  LOOP_MIN_INTERVAL,
} from '../../shared/session-loop.js';
import { idSchema, loopVersionSchema, mutateSessionLoopSchema } from '../../shared/validation.js';
import type { GatewayService } from '../service.js';
import { hashedOperationKey, toolResult } from './tools.js';

export const listLoopsInput = z.object({}).strict();

const requestKey = z
  .string()
  .uuid()
  .optional()
  .describe('Reuse for retries of the same intended mutation.');
const interval = z
  .number()
  .int()
  .min(1)
  .max(LOOP_MAX_INTERVAL / LOOP_MIN_INTERVAL);

export const createLoopInput = z
  .object({
    prompt: z
      .string()
      .max(LOOP_MAX_PROMPT)
      .refine((value) => Boolean(value.trim())),
    interval_minutes: interval.optional().describe('Omit for an adaptive loop.'),
    request_key: requestKey,
  })
  .strict();

export const updateLoopInput = z
  .object({
    loop_id: idSchema,
    version: loopVersionSchema.describe('Use the current version returned by list_loops.'),
    action: z.enum(['pause', 'resume', 'cancel', 'set_interval']),
    interval_minutes: interval.optional().describe('Required for set_interval.'),
    request_key: requestKey,
  })
  .strict();

const metadata = z.object({ threadId: idSchema, callId: idSchema });

type LoopCall =
  | { tool: 'list_loops'; input: z.infer<typeof listLoopsInput> }
  | { tool: 'create_loop'; input: z.infer<typeof createLoopInput> }
  | { tool: 'update_loop'; input: z.infer<typeof updateLoopInput> };

function receipt(operation: Operation, requestKey: string) {
  return toolResult(
    {
      request_key: requestKey,
      operation_id: operation.clientOperationId,
      status: operation.status,
      ...(operation.result ? { loop: operation.result } : {}),
      ...(operation.error ? { error: operation.error } : {}),
    },
    operation.status === 'failed' || operation.status === 'unknown',
  );
}

export class SessionLoopTools {
  constructor(
    private readonly service: GatewayService,
    private readonly logger: Logger,
  ) {}

  async invoke(call: LoopCall, meta: unknown, signal: AbortSignal) {
    let requestKey: string | undefined;
    let operationId: string | undefined;
    try {
      const { tool, input } = call;
      const parsed = metadata.safeParse(meta);
      if (!parsed.success) throw this.contextRequired();
      const { threadId, callId } = parsed.data;
      // HTTP can reach the listener before the owned stdio notification is delivered.
      let caller = this.service.managedLoopCaller(threadId, callId, tool, input);
      for (const delay of [25, 100, 250, 500]) {
        if (caller || signal.aborted) break;
        await setTimeout(delay, undefined, { signal });
        caller = this.service.managedLoopCaller(threadId, callId, tool, input);
      }
      if (!caller || signal.aborted) throw this.contextRequired();
      const context = caller;
      return await withLogContext({ threadId, turnId: context.turnId }, async () => {
        if (call.tool === 'list_loops')
          return toolResult({ loops: await this.service.listSessionLoops(threadId) });
        requestKey =
          call.input.request_key ?? hashedOperationKey(`covro.${tool}.native`, threadId, callId);
        operationId = hashedOperationKey(`covro.${tool}`, threadId, requestKey);
        const identity = { clientOperationId: operationId };
        const intervalMs =
          call.input.interval_minutes === undefined
            ? undefined
            : call.input.interval_minutes * LOOP_MIN_INTERVAL;

        let operation;
        if (call.tool === 'create_loop') {
          operation = await this.service.createSessionLoop(
            threadId,
            {
              ...identity,
              prompt: call.input.prompt,
              ...(intervalMs === undefined ? { mode: 'adaptive' as const } : { intervalMs }),
            },
            context,
          );
        } else {
          const control = mutateSessionLoopSchema.safeParse({
            ...identity,
            action: call.input.action,
            version: call.input.version,
            ...(intervalMs === undefined ? {} : { intervalMs }),
          });
          if (!control.success)
            throw new AppError(
              'VALIDATION_ERROR',
              'Supply interval_minutes only for set_interval',
              400,
            );
          operation = await this.service.controlSessionLoop(
            threadId,
            call.input.loop_id,
            control.data,
            context,
          );
        }
        return receipt(operation, requestKey);
      });
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof AppError && error.code === 'MCP_SESSION_REQUIRED')
          this.logger.warn('mcp.loop_context_rejected', { kind: call.tool, ...errorFields(error) });
        else if (!(error instanceof AppError))
          this.logger.warn('mcp.loop_failed', { kind: call.tool, ...errorFields(error) });
      }
      return toolResult(
        {
          ...(requestKey ? { request_key: requestKey } : {}),
          ...(operationId ? { operation_id: operationId } : {}),
          error:
            error instanceof AppError
              ? error.toJSON()
              : { code: 'INTERNAL_ERROR', message: 'Unable to manage the loop' },
        },
        true,
      );
    }
  }

  private contextRequired() {
    return new AppError(
      'MCP_SESSION_REQUIRED',
      'Call this tool from an active Covro-managed session',
      403,
    );
  }
}

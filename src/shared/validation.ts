import { z } from 'zod';
import { imageDataBytes, MAX_IMAGE_BYTES, MAX_IMAGES } from './images.js';
import type { TaskMessage } from './types.js';
import { threadNameError } from './thread-name.js';
export const cursorSchema = z.string().min(1).max(4096);
export const idSchema = z.string().min(1).max(256);
const projectNameSchema = z.string().trim().min(1).max(100);
export const createProjectSchema = z
  .object({ path: z.string().trim().min(1).max(4096), name: projectNameSchema.optional() })
  .strict();
export const renameProjectSchema = z.object({ name: projectNameSchema }).strict();
export const cloneProjectSchema = createProjectSchema.extend({
  clientOperationId: z.string().uuid(),
  repository: z.string().trim().min(1).max(4096),
});
export const removeProjectSchema = z.object({}).strict();
export const reorderProjectsSchema = z
  .object({ projectIds: z.array(idSchema).refine((ids) => new Set(ids).size === ids.length) })
  .strict();
export const settingsSchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    collaborationMode: z.enum(['plan', 'default']).optional(),
    reasoningEffort: z.string().min(1).max(40).optional(),
    serviceTier: z.literal('fast').nullable().optional(),
    permissionMode: z.enum(['ask', 'auto-review', 'full-access', 'read-only']).optional(),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
    approvalReviewer: z.enum(['user', 'auto_review']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  })
  .strict()
  .refine(
    (settings) =>
      settings.permissionMode === undefined ||
      (settings.sandbox === undefined &&
        settings.approvalPolicy === undefined &&
        settings.approvalReviewer === undefined),
    '权限模式不能与独立的权限、审批策略或审核方同时设置',
  );
export const operationSchema = z.object({ clientOperationId: z.string().uuid() }).strict();
export const updateLiveSettingsSchema = operationSchema.extend({
  expectedTurnId: idSchema,
  settings: z
    .object({
      serviceTier: z.literal('fast').nullable().optional(),
      permissionMode: z.enum(['ask', 'auto-review', 'full-access', 'read-only']).optional(),
    })
    .strict()
    .refine((settings) => Object.keys(settings).length > 0, 'Settings are required'),
});
export const saveModelDefaultsSchema = operationSchema.extend({
  settings: z
    .object({
      model: z.string().min(1).max(200),
      reasoningEffort: z.string().min(1).max(40).nullable(),
    })
    .strict(),
});
export const reviewTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uncommittedChanges') }).strict(),
  z
    .object({
      type: z.literal('baseBranch'),
      branch: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .refine(
          (branch) =>
            !branch.startsWith('-') &&
            !/\s/.test(branch) &&
            [...branch].every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127),
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('commit'),
      sha: z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{7,64}$/),
    })
    .strict(),
  z
    .object({ type: z.literal('custom'), instructions: z.string().trim().min(1).max(100_000) })
    .strict(),
]);
export const startReviewSchema = operationSchema.extend({ target: reviewTargetSchema.optional() });
export const confirmCompatibilitySchema = operationSchema.extend({
  codexEpoch: idSchema,
  codexVersion: z.string().min(1).max(200),
  verifiedVersion: z.string().min(1).max(200),
  confirm: z.literal(true),
});
export const createThreadSchema = operationSchema.extend({ settings: settingsSchema.optional() });
export const forkThreadSchema = createThreadSchema;
export const renameThreadSchema = operationSchema.extend({
  name: z
    .string()
    .superRefine((name, context) => {
      const message = threadNameError(name);
      if (message) context.addIssue({ code: 'custom', message });
    })
    .transform((name) => name.trim()),
});
export const resumeThreadSchema = createThreadSchema.extend({
  confirmExternalStopped: z.boolean().optional(),
});
const taskFields = {
  skills: z
    .array(
      z
        .object({
          name: z.string().min(1).max(256),
          path: z.string().min(1).max(4096),
          cwd: z.string().min(1).max(4096),
        })
        .strict(),
    )
    .max(32)
    .optional(),
  text: z.string().max(100_000),
  images: z
    .array(z.string().refine((value) => imageDataBytes(value) !== undefined, 'Invalid image'))
    .max(MAX_IMAGES)
    .refine(
      (images) =>
        images.reduce((sum, image) => sum + (imageDataBytes(image) ?? Infinity), 0) <=
        MAX_IMAGE_BYTES,
      'Images exceed size limit',
    )
    .optional(),
};
const hasContent = (input: TaskMessage) => Boolean(input.text.trim() || input.images?.length);
export const startTurnSchema = createThreadSchema
  .extend({
    ...taskFields,
    taskKind: z.literal('init').optional(),
  })
  .refine(hasContent, 'Text or an image is required')
  .refine(
    (input) => input.taskKind !== 'init' || (!input.images?.length && !input.skills?.length),
    'Project initialization cannot include images',
  );
export const steerSchema = operationSchema
  .extend({
    expectedTurnId: idSchema,
    ...taskFields,
  })
  .refine(hasContent, 'Text or an image is required');
export const goalMutationSchema = z.discriminatedUnion('action', [
  operationSchema.extend({
    action: z.literal('clear'),
    confirm: z.literal(true),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  operationSchema
    .extend({
      action: z.literal('set'),
      confirm: z.literal(true),
      expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
      objective: z.string().trim().min(1).max(10000).optional(),
      status: z.enum(['active', 'paused', 'complete']).optional(),
      tokenBudget: z.number().int().positive().max(1000000000).optional(),
    })
    .refine(
      (value) =>
        value.objective !== undefined ||
        value.status !== undefined ||
        value.tokenBudget !== undefined,
      'Goal update is empty',
    ),
]);
export const recapSchema = operationSchema.extend({
  language: z.enum(['en', 'zh-Hans', 'ja', 'ko']),
});
export const approveDenialSchema = operationSchema.extend({
  denialId: idSchema,
  confirm: z.literal(true),
});
export const interruptSchema = operationSchema.extend({ expectedTurnId: idSchema });
export const retryTurnSchema = createThreadSchema.extend({ expectedTurnId: idSchema });
const elicitationValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(10_000)).max(500),
]);
export const resolveActionSchema = operationSchema.extend({
  resolution: z.union([
    z
      .object({
        decision: z.string().min(1).max(200),
        content: z.record(z.string().max(1000), elicitationValueSchema).optional(),
        persist: z.literal('session').optional(),
      })
      .strict(),
    z.object({ answers: z.record(z.string(), z.array(z.string().max(10_000)).max(50)) }).strict(),
  ]),
});
export const reconcileSchema = operationSchema.extend({ confirmEnded: z.literal(true) });
export const subscribeSchema = z
  .object({
    type: z.literal('subscribe'),
    threadId: idSchema,
    incremental: z.boolean().optional(),
    after: z
      .object({ serverEpoch: idSchema, seq: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export const socketMessageSchema = z.discriminatedUnion('type', [
  subscribeSchema,
  z.object({ type: z.literal('unsubscribe') }).strict(),
]);

export const archiveThreadSchema = operationSchema.extend({ archived: z.boolean() });
export const archivedQuerySchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const skillsQuerySchema = z
  .object({
    projectId: idSchema.nullable(),
    threadId: idSchema.optional(),
    draftId: z.string().uuid().optional(),
    forceReload: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.projectId !== null || value.threadId || value.draftId,
    'A session or draft is required',
  );

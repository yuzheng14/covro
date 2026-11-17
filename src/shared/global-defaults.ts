import { z } from 'zod';
import type { ModelInfo, PermissionCapabilities, PermissionMode } from './types.js';

export const globalDefaultsSettingsSchema = z
  .object({
    model: z.string().min(1).max(200).nullable(),
    reasoningEffort: z.string().min(1).max(40).nullable(),
    permissionMode: z.enum(['ask', 'auto-review', 'full-access', 'read-only']).nullable(),
  })
  .strict();
export const saveGlobalDefaultsSchema = z
  .object({
    clientOperationId: z.string().uuid(),
    version: z.string().min(1).max(256).nullable(),
    settings: globalDefaultsSettingsSchema,
  })
  .strict();
export interface GlobalDefaultSettings {
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: PermissionMode | null;
}
export interface GlobalDefaultsSnapshot {
  settings: GlobalDefaultSettings;
  models: ModelInfo[];
  capabilities: PermissionCapabilities;
  version: string | null;
}
export type SaveGlobalDefaultsInput = z.infer<typeof saveGlobalDefaultsSchema>;

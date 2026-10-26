import type { RuntimeSettings, Settings } from '../shared/types.js';
import type { CollaborationMode } from './generated/CollaborationMode.js';
import type { ReasoningEffort } from './generated/ReasoningEffort.js';
import { AppError } from '../shared/errors.js';
import { isRecord } from './transport.js';

/** 0.164.0 experimental fields, kept outside the generated stable protocol. */
export type CollaborationProvenance = { collaborationMode?: CollaborationMode | null };

export function reportedCollaborationMode(
  value: unknown,
): Pick<RuntimeSettings, 'collaborationMode'> {
  if (!isRecord(value) || (value.mode !== 'plan' && value.mode !== 'default')) return {};
  return { collaborationMode: value.mode };
}

export function collaborationSelection(
  settings: Settings | undefined,
  current: RuntimeSettings | undefined,
): CollaborationProvenance {
  if (!settings?.collaborationMode) return {};
  const model = settings.model ?? current?.model;
  if (!model)
    throw new AppError('MODEL_UNAVAILABLE', 'Codex has not reported a model for this session');
  return {
    collaborationMode: {
      mode: settings.collaborationMode,
      settings: {
        model,
        reasoning_effort: (settings.reasoningEffort ??
          current?.reasoningEffort ??
          null) as ReasoningEffort | null,
        // null selects the server's built-in instructions, never a client-authored prompt.
        developer_instructions: null,
      },
    },
  };
}

import type { ModelInfo } from '../shared/types.js';
import type { ModelListParams } from './generated/v2/ModelListParams.js';
import type { ModelListResponse } from './generated/v2/ModelListResponse.js';
import { CodexError } from './transport.js';

// Additive 0.169.0 selector; kept explicit while the protocol upgrade is reviewed separately.
export type ModelCatalogParams = ModelListParams & { modelProvider?: string };

/** Every read reaches Codex, including cache hits there, to recheck managed provider policy. */
export async function readModels(
  request: (params: ModelCatalogParams) => Promise<ModelListResponse>,
  modelProvider?: string,
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await request({
      limit: 100,
      ...(modelProvider ? { modelProvider } : {}),
      ...(cursor ? { cursor } : {}),
    });
    models.push(
      ...page.data.map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        reasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        defaultReasoningEffort: model.defaultReasoningEffort,
        serviceTiers:
          model.serviceTiers?.map((tier) => (tier.id === 'priority' ? 'fast' : tier.id)) ??
          model.additionalSpeedTiers,
      })),
    );
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100))
      throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid model pagination');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

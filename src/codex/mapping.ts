import type {
  ItemView,
  RunStatus,
  RuntimeSettings,
  Settings,
  ThreadView,
  TurnView,
} from '../shared/types.js';
import { permissionModes } from '../shared/permissions.js';
import type { PermissionSelection } from './permissions.js';
export { permissionSettings } from './permissions.js';
import type { Thread } from './generated/v2/Thread.js';
import type { ThreadItem } from './generated/v2/ThreadItem.js';
import type { ThreadStatus } from './generated/v2/ThreadStatus.js';
import type { Turn } from './generated/v2/Turn.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import type { TurnStartParams } from './generated/v2/TurnStartParams.js';
import type { ReasoningEffort } from './generated/ReasoningEffort.js';
import type { UserInput } from './generated/v2/UserInput.js';
import { parseQuestionReplies } from '../shared/async-questions.js';
import { imageDataBytes, MAX_IMAGES, MAX_IMAGE_BYTES } from '../shared/images.js';
import { CodexError, isRecord } from './transport.js';

/** Keep public diagnostics bounded and independent of upstream protocol types. */
export function mapTurnError(error: {
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}) {
  const info = error.codexErrorInfo;
  const code = typeof info === 'string' ? info : isRecord(info) ? Object.keys(info)[0] : undefined;
  return {
    ...(code ? { errorCode: code.slice(0, 100) } : {}),
    ...(error.additionalDetails ? { errorDetails: error.additionalDetails.slice(0, 4096) } : {}),
  };
}

export function taskInput(
  text: string,
  images: string[] = [],
  skills: import('../shared/skills.js').SkillReference[] = [],
): UserInput[] {
  return [
    ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
    ...images.map((url) => ({ type: 'image' as const, url })),
    ...skills.map(({ name, path }) => ({ type: 'skill' as const, name, path })),
  ];
}

/** Codex 0.164.0 reports Fast as priority and standard speed as default. */
export function serviceTierSettings(
  tier: string | null | undefined,
): Pick<RuntimeSettings, 'serviceTier'> {
  if (tier === undefined) return {};
  return { serviceTier: tier === 'priority' ? 'fast' : tier === 'default' ? null : tier };
}

export function threadStatus(status: ThreadStatus): RunStatus {
  if (!isRecord(status))
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex thread status is malformed', true);
  if (status.type === 'notLoaded') return 'unknown';
  if (status.type === 'idle') return 'idle';
  if (status.type === 'systemError') return 'failed';
  if (status.type !== 'active' || !Array.isArray(status.activeFlags))
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex thread status is not supported', true);
  if (status.activeFlags.includes('waitingOnApproval')) return 'waitingApproval';
  if (status.activeFlags.includes('waitingOnUserInput')) return 'waitingInput';
  return 'running';
}
export function mapThread(thread: Thread): ThreadView {
  assertObjectId(thread, 'thread');
  if (typeof thread.cwd !== 'string' || !Array.isArray(thread.turns) || !isRecord(thread.status))
    throw new CodexError(
      'PROTOCOL_INCOMPATIBLE',
      'Codex thread response is missing required fields',
      true,
    );
  const turns = thread.turns.map((turn) => mapTurn(thread.id, turn));
  let status = threadStatus(thread.status);
  // Persisted history is normally notLoaded after a restart, even when every turn
  // finished. Keep unfinished history uncertain; the gateway separately overlays
  // durable execution markers, including dispatches without a known turn ID.
  if (thread.status.type === 'notLoaded' && !turns.some((turn) => turn.status === 'running'))
    status = turns.at(-1)?.status ?? 'idle';
  return {
    id: thread.id,
    ...(typeof thread.forkedFromId === 'string' ? { forkedFromId: thread.forkedFromId } : {}),
    projectId: '',
    cwd: thread.cwd,
    source: typeof thread.source === 'string' ? thread.source : JSON.stringify(thread.source),
    originator: typeof thread.originator === 'string' ? thread.originator : null,
    title: thread.name || thread.preview || '新会话',
    // List/metadata responses omit turns. The native preview is history evidence.
    hasMessages: Boolean(thread.preview) || thread.turns.length > 0,
    status,
    turns,
    managed: false,
    runtimeSettings: {
      model: thread.model ?? null,
      reasoningEffort: thread.reasoningEffort ?? null,
    },
    updatedAt: thread.updatedAt * 1000,
    actions: [],
  };
}
export function mapTurn(threadId: string, turn: Turn): TurnView {
  assertObjectId(turn, 'turn');
  if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status))
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex turn status is not supported', true);
  if (!Array.isArray(turn.items))
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex turn response is missing items', true);
  return {
    id: turn.id,
    threadId,
    status: turn.status === 'inProgress' ? 'running' : turn.status,
    ...(validTiming(turn.startedAt) ? { startedAt: turn.startedAt * 1000 } : {}),
    ...(validTiming(turn.completedAt) ? { completedAt: turn.completedAt * 1000 } : {}),
    ...(validTiming(turn.durationMs) ? { durationMs: turn.durationMs } : {}),
    items: turn.items.map(mapItem),
    ...(turn.error ? { error: turn.error.message, ...mapTurnError(turn.error) } : {}),
  };
}
function validTiming(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function mapItem(item: ThreadItem): ItemView {
  assertObjectId(item, 'item');
  if (typeof item.type !== 'string')
    throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex item has no type', true);
  switch (item.type) {
    case 'userMessage': {
      const content = item.content.filter((input) => !['skill', 'mention'].includes(input.type));
      const replies =
        content.length === 1 && content[0]?.type === 'text'
          ? parseQuestionReplies(content[0].text)
          : undefined;
      const imageInputs = item.content.filter(
        (input) => input.type === 'image' || input.type === 'localImage',
      );
      let bytes = 0;
      const images = imageInputs.slice(0, MAX_IMAGES).flatMap((input) => {
        if (input.type !== 'image' || !('url' in input)) return [];
        const size = imageDataBytes(input.url);
        if (size === undefined || bytes + size > MAX_IMAGE_BYTES) return [];
        bytes += size;
        return [input.url];
      });
      return {
        id: item.id,
        type: item.type,
        text: replies
          ? replies.map((reply) => `${reply.question}\n${reply.answer}`).join('\n\n')
          : item.content
              .filter((input) => input.type !== 'image' && input.type !== 'localImage')
              .map((input) => (input.type === 'text' ? input.text : `[${input.type}]`))
              .join('\n'),
        ...(replies ? { questionReplies: replies } : {}),
        ...(imageInputs.length ? { images, imageCount: imageInputs.length } : {}),
      };
    }
    case 'agentMessage':
      return {
        id: item.id,
        type: item.type,
        text: item.text,
        ...(item.delivery ? { delivery: item.delivery } : {}),
        ...(item.questions?.length ? { questions: structuredClone(item.questions) } : {}),
      };
    case 'reasoning':
      return { id: item.id, type: item.type, text: [...item.summary, ...item.content].join('\n') };
    case 'plan':
      return { id: item.id, type: item.type, text: item.text };
    case 'contextCompaction':
      // Lifecycle is carried by notifications, not the persisted item body.
      return { id: item.id, type: item.type };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { id: item.id, type: item.type, text: item.review };
    case 'commandExecution':
      return {
        id: item.id,
        type: item.type,
        status: item.status,
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? '',
        ...(item.exitCode !== null && item.exitCode !== 0
          ? { error: `退出代码 ${item.exitCode}` }
          : {}),
      };
    case 'fileChange':
      return {
        id: item.id,
        type: item.type,
        status: item.status,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind.type,
          diff: change.diff,
        })),
      };
    default:
      return {
        id: item.id,
        type: item.type,
        ...('status' in item ? { status: String(item.status) } : {}),
        details: item,
      };
  }
}
export function threadSettings(
  settings: Settings = {},
): Pick<
  ThreadStartParams,
  'model' | 'serviceTier' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'config'
> &
  PermissionSelection {
  const preset = settings.permissionMode && permissionModes[settings.permissionMode];
  return {
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    ...(settings.approvalPolicy === undefined ? {} : { approvalPolicy: settings.approvalPolicy }),
    ...(settings.approvalReviewer === undefined
      ? {}
      : { approvalsReviewer: settings.approvalReviewer }),
    ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    ...(preset
      ? {
          permissions: preset.profile,
          approvalPolicy: preset.approvalPolicy,
          approvalsReviewer: preset.approvalReviewer,
        }
      : {}),
    ...(settings.reasoningEffort === undefined
      ? {}
      : { config: { model_reasoning_effort: settings.reasoningEffort } }),
  };
}
export function turnSettings(
  cwd: string,
  settings: Settings = {},
): Pick<
  TurnStartParams,
  'model' | 'serviceTier' | 'approvalPolicy' | 'approvalsReviewer' | 'sandboxPolicy' | 'effort'
> &
  PermissionSelection {
  const preset = settings.permissionMode && permissionModes[settings.permissionMode];
  const sandboxPolicy: TurnStartParams['sandboxPolicy'] =
    settings.sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : settings.sandbox === 'workspace-write'
        ? {
            type: 'workspaceWrite',
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : settings.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : undefined;
  return {
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    ...(settings.approvalPolicy === undefined ? {} : { approvalPolicy: settings.approvalPolicy }),
    ...(settings.approvalReviewer === undefined
      ? {}
      : { approvalsReviewer: settings.approvalReviewer }),
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(preset
      ? {
          permissions: preset.profile,
          approvalPolicy: preset.approvalPolicy,
          approvalsReviewer: preset.approvalReviewer,
        }
      : {}),
    ...(settings.reasoningEffort === undefined
      ? {}
      : { effort: settings.reasoningEffort as ReasoningEffort }),
  };
}
function assertObjectId(value: unknown, kind: string): void {
  if (!isRecord(value) || typeof value.id !== 'string')
    throw new CodexError('PROTOCOL_INCOMPATIBLE', `Codex ${kind} has no stable id`, true);
}

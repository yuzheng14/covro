import { MODEL_CAPACITY_MESSAGE } from '../../src/shared/turn-errors.js';
import { diffPreviewChanges } from './diff-preview';
/** Explicit test process. Its envelopes and payloads use the checked-in CLI-generated protocol. */
import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mermaidChunks } from './mermaid.js';
import type { ClientRequest } from '../../src/codex/generated/ClientRequest.js';
import type { ServerNotification } from '../../src/codex/generated/ServerNotification.js';
import type { ServerRequest } from '../../src/codex/generated/ServerRequest.js';
import type { ReasoningEffort } from '../../src/codex/generated/ReasoningEffort.js';
import type { ThreadStartParams } from '../../src/codex/generated/v2/ThreadStartParams.js';
import type { Thread } from '../../src/codex/generated/v2/Thread.js';
import type { Turn } from '../../src/codex/generated/v2/Turn.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { Model } from '../../src/codex/generated/v2/Model.js';
import type { ThreadStartResponse } from '../../src/codex/generated/v2/ThreadStartResponse.js';
import type { InitializeResponse } from '../../src/codex/generated/InitializeResponse.js';
import type { RequestId } from '../../src/codex/generated/RequestId.js';
import type { RequestPermissionProfile } from '../../src/codex/generated/v2/RequestPermissionProfile.js';
import type { McpElicitationSchema } from '../../src/codex/generated/v2/McpElicitationSchema.js';
import type { JsonValue } from '../../src/codex/generated/serde_json/JsonValue.js';
import type { GuardianApprovalReviewStatus } from '../../src/codex/generated/v2/GuardianApprovalReviewStatus.js';
import type { PermissionRequirements, PermissionSelection } from '../../src/codex/permissions.js';
import type { ActivePermissionProfile } from '../../src/codex/generated/v2/ActivePermissionProfile.js';

export interface SimulatorOptions {
  configOverrides?: Record<string, JsonValue>;
  requirements?: Partial<PermissionRequirements> | null;
  guardianApproval?: boolean;
  rejectPermissions?: boolean;
  ignorePermissions?: boolean;
  settingsOnFeatureRead?: boolean;
  configModel?: string | null;
  configEffort?: ReasoningEffort | null;
  configWriteStatus?: 'ok' | 'okOverridden';
  configWriteFailure?: boolean;
  fragmentBytes?: number;
  ackDelayMs?: number;
  interruptCompletionDelayMs?: number;
  turnDelayMs?: number;
  compactStartDelayMs?: number;
  compactFailure?: boolean;
  outputBytes?: number;
  crashAfterDispatch?: boolean;
  unsupportedMethod?: string;
  initializeFailureOncePath?: string;
  logPath?: string;
  historyPath?: string;
  paginated?: boolean;
  activeArchiveDescendant?: boolean;
  vanishedLoadedThread?: boolean;
  historyPageSize?: number;
  historyItemSummaries?: boolean;
  history?: { turns: number; itemsPerTurn: number; itemBytes: number };
  forkHistoryReadError?: boolean;
  malformedForkReceipt?: boolean;
  resumeFailure?: { code: number; message: string };
  approval?:
    | 'command'
    | 'file'
    | 'network'
    | 'questions'
    | 'questions-choice'
    | 'unsupported'
    | 'permissions'
    | 'elicitation-form'
    | 'elicitation-choice'
    | 'elicitation-confirm'
    | 'elicitation-approval'
    | 'elicitation-session'
    | 'elicitation-session-array'
    | 'elicitation-url'
    | 'elicitation-openai'
    | 'elicitation-openai-form'
    | 'elicitation-malformed';
  permissions?: RequestPermissionProfile;
  elicitationSchema?: unknown;
  elicitationMeta?: JsonValue;
  elicitationTurnId?: null;
  malformed?: boolean;
  hugeLineBytes?: number;
  malformedTurnReceipt?: boolean;
  reviewFailure?: string;
  reviewWrongThread?: boolean;
  nonblockingQuestions?: boolean;
  threadNames?: string[];
  titleOutput?: string;
  titleOutputs?: string[];
  accountType?: 'chatgpt' | 'apiKey';
  models?: string[];
  modelProvider?: string;
  activePermissionProfile?: string;
  temporaryPermissionProfile?: string;
  userMessageDelayMs?: number;
  titleDelayMs?: number;
  nameWriteDelayMs?: number;
  threadStartedDelayMs?: number;
  titleBehavior?: 'fail' | 'hang' | 'rename' | 'interaction';
  autoReview?: Exclude<GuardianApprovalReviewStatus, 'inProgress'> | 'unfinished';
  autoReviewDelayMs?: number;
}
const optionsIndex = process.argv.indexOf('--options');
const options = JSON.parse(
  optionsIndex < 0 ? '{}' : (process.argv[optionsIndex + 1] ?? '{}'),
) as SimulatorOptions;
const threads = new Map<string, Thread>();
const archived = new Set<string>();
if (options.historyPath && existsSync(options.historyPath)) {
  const saved = JSON.parse(readFileSync(options.historyPath, 'utf8')) as {
    threads: Thread[];
    archived: string[];
  };
  for (const thread of saved.threads) {
    thread.status = { type: 'notLoaded' };
    threads.set(thread.id, thread);
  }
  for (const id of saved.archived) archived.add(id);
}
const policies = new Map<
  string,
  Pick<ThreadStartResponse, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>
>();
const profiles = new Map<string, ActivePermissionProfile>();
const serviceTiers = new Map<string, string | null>();
const reportedTier = (id: string) =>
  serviceTiers.get(id) === 'fast' ? 'priority' : (serviceTiers.get(id) ?? 'default');
const finishes = new Map<string, NodeJS.Timeout>();
type ServerReply = { id: RequestId; result?: unknown; error?: unknown };
const callbacks = new Map<RequestId, (response: ServerReply) => void>();
let initialized = false;
let handshaken = false;
let nextRequestId = 0;
let titleAttempts = 0;
let savedModelDefaults: { model: string; effort: ReasoningEffort | null } | undefined;
let writes = Promise.resolve();
function send(message: unknown): void {
  const data = Buffer.from(JSON.stringify(message) + '\n');
  writes = writes.then(async () => {
    const size = Math.max(1, options.fragmentBytes ?? data.length);
    for (let offset = 0; offset < data.length; offset += size) {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(data.subarray(offset, offset + size), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  });
}
function notify(event: ServerNotification): void {
  send(event);
}
function reply(id: RequestId, result: unknown): void {
  send({ id, result });
}
function error(id: RequestId, message: string, code = -32602): void {
  send({ id, error: { code, message } });
}
function makeThread(cwd: string): Thread {
  const id = randomUUID();
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: options.paginated ? 'paginated' : 'legacy',
    modelProvider: options.modelProvider ?? 'openai',
    model: savedModelDefaults?.model ?? 'simulated-model',
    reasoningEffort: savedModelDefaults
      ? savedModelDefaults.effort
      : cwd.endsWith('other-project')
        ? 'high'
        : 'medium',
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: CODEX_COMPATIBILITY.recommended,
    originator: 'codex_web_ui',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
function policy(thread: Thread) {
  return (
    policies.get(thread.id) ?? {
      approvalPolicy: 'on-request' as const,
      approvalsReviewer: 'user' as const,
      sandbox: { type: 'readOnly' as const, networkAccess: false },
    }
  );
}
function startResponse(
  thread: Thread,
): ThreadStartResponse & { activePermissionProfile?: { id: string } } {
  return {
    thread,
    model: thread.model ?? 'simulated-model',
    modelProvider: thread.modelProvider,
    serviceTier: reportedTier(thread.id),
    disabledPluginIds: [],
    cwd: thread.cwd,
    instructionSources: [],
    ...policy(thread),
    reasoningEffort: thread.reasoningEffort,
    ...(thread.ephemeral && options.temporaryPermissionProfile
      ? { activePermissionProfile: { id: options.temporaryPermissionProfile, extends: null } }
      : profiles.has(thread.id)
        ? { activePermissionProfile: profiles.get(thread.id) }
        : options.activePermissionProfile
          ? {
              activePermissionProfile: {
                id: thread.ephemeral
                  ? (options.temporaryPermissionProfile ?? options.activePermissionProfile)
                  : options.activePermissionProfile,
                extends: null,
              },
            }
          : { activePermissionProfile: { id: ':read-only', extends: null } }),
  };
}
function applySettings(
  thread: Thread,
  settings: Pick<
    ThreadStartParams,
    'model' | 'serviceTier' | 'config' | 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'
  > &
    PermissionSelection,
) {
  if (settings.model) thread.model = settings.model;
  if (settings.serviceTier !== undefined) serviceTiers.set(thread.id, settings.serviceTier);
  const effort = settings.config?.model_reasoning_effort;
  if (typeof effort === 'string') thread.reasoningEffort = effort as ReasoningEffort;
  const current = policy(thread);
  if (settings.permissions && !options.ignorePermissions) {
    profiles.set(thread.id, { id: settings.permissions, extends: null });
    settings = {
      ...settings,
      sandbox:
        settings.permissions === ':workspace'
          ? 'workspace-write'
          : settings.permissions === ':danger-full-access'
            ? 'danger-full-access'
            : 'read-only',
    };
  }
  if (settings.approvalPolicy) current.approvalPolicy = settings.approvalPolicy;
  if (settings.approvalsReviewer) current.approvalsReviewer = settings.approvalsReviewer;
  if (settings.sandbox)
    current.sandbox =
      settings.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : settings.sandbox === 'read-only'
          ? { type: 'readOnly', networkAccess: false }
          : {
              type: 'workspaceWrite',
              writableRoots: [thread.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            };
  policies.set(thread.id, current);
}
function notifySettings(thread: Thread) {
  notify({
    method: 'thread/settings/updated',
    params: {
      threadId: thread.id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: thread.cwd,
        approvalPolicy: policy(thread).approvalPolicy,
        approvalsReviewer: policy(thread).approvalsReviewer,
        sandboxPolicy: policy(thread).sandbox,
        activePermissionProfile: profiles.get(thread.id) ?? {
          id: options.activePermissionProfile ?? ':read-only',
          extends: null,
        },
        model: thread.model!,
        modelProvider: thread.modelProvider,
        serviceTier: reportedTier(thread.id),
        effort: thread.reasoningEffort,
        summary: null,
        personality: null,
        collaborationMode: {
          mode: 'default',
          settings: {
            model: thread.model!,
            reasoning_effort: thread.reasoningEffort,
            developer_instructions: null,
          },
        },
      },
    },
  });
}
function command(id: string, cwd: string): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: 'printf "你好 Codex"',
    cwd,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}
const outputTotals = new Map<string, number>();
function complete(
  thread: Thread,
  turn: Turn,
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
): void {
  clearTimeout(finishes.get(turn.id));
  finishes.delete(turn.id);
  if (turn.status !== 'inProgress') return;
  turn.status = status;
  turn.completedAt = Date.now() / 1000;
  turn.durationMs =
    turn.startedAt === null ? null : Math.round((turn.completedAt - turn.startedAt) * 1000);
  // Explicit test prompts exercise historical timing through the real protocol and gateway.
  const timingScenario = turn.items
    .flatMap((item) =>
      item.type === 'userMessage'
        ? item.content.flatMap((input) => (input.type === 'text' ? input.text : []))
        : [],
    )
    .join(' ')
    .match(/\[turn-timing:(cross-day|hours|duration-only|time-only|missing)\]/)?.[1];
  if (timingScenario) {
    turn.completedAt =
      Date.parse(timingScenario === 'hours' ? '2026-10-16T06:32:08Z' : '2026-10-14T16:01:15Z') /
      1000;
    turn.durationMs = timingScenario === 'hours' ? 3_661_000 : 135_000;
    turn.startedAt = turn.completedAt - turn.durationMs / 1000;
    if (timingScenario === 'duration-only' || timingScenario === 'missing') turn.completedAt = null;
    if (timingScenario === 'time-only' || timingScenario === 'missing') turn.durationMs = null;
    if (timingScenario === 'missing') turn.startedAt = null;
  }
  const tpsScenario = turn.items
    .flatMap((item) =>
      item.type === 'userMessage'
        ? item.content.flatMap((input) => (input.type === 'text' ? input.text : []))
        : [],
    )
    .join(' ')
    .match(/\[turn-tps:(multi|next|missing)\]/)?.[1];
  if (tpsScenario) {
    turn.durationMs = 20_000;
    if (tpsScenario !== 'missing') {
      for (const delta of tpsScenario === 'multi' ? [400, 0, 800] : [300]) {
        const total = (outputTotals.get(thread.id) ?? 0) + delta;
        outputTotals.set(thread.id, total);
        const usage = {
          totalTokens: total + 5000,
          inputTokens: 5000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: total,
          reasoningOutputTokens: 100,
        };
        notify({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            tokenUsage: {
              total: usage,
              last: { ...usage, outputTokens: delta },
              modelContextWindow: 200_000,
            },
          },
        });
      }
    }
  }
  thread.status = { type: 'idle' };
  // Explicit test prompt: retain real terminal history while dropping its notification.
  if (
    !turn.items.some(
      (item) =>
        item.type === 'userMessage' &&
        item.content.some(
          (input) => input.type === 'text' && input.text.includes('[miss-completion]'),
        ),
    )
  )
    notify({ method: 'turn/completed', params: { threadId: thread.id, turn } });
  notify({
    method: 'thread/status/changed',
    params: { threadId: thread.id, status: thread.status },
  });
  if (thread.preview.includes('[unload]')) {
    // Exercise the real notification → gateway cache → history-read recovery path.
    thread.status = { type: 'notLoaded' };
    notify({
      method: 'thread/status/changed',
      params: { threadId: thread.id, status: thread.status },
    });
  }
}
function asyncQuestions(thread: Thread, turn: Turn, running: boolean, multiple: boolean): void {
  const groups = [
    [
      { title: '界面使用哪种主题？', options: ['深色（推荐）', '浅色'] },
      { title: '项目名称是什么？', options: null },
    ],
    ...(multiple ? [[{ title: '需要哪些补充说明？', options: null }]] : []),
  ];
  for (const questions of groups) {
    const item: ThreadItem = {
      id: randomUUID(),
      type: 'agentMessage',
      phase: 'final_answer',
      memoryCitation: null,
      delivery: 'async',
      questions,
      text: questions
        .map((q) => [q.title, ...(q.options ?? []).map((option) => `- ${option}`)].join('\n'))
        .join('\n\n'),
    };
    turn.items.push(item);
    notify({
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
    });
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
    });
  }
  if (running)
    finishes.set(
      turn.id,
      setTimeout(() => complete(thread, turn), 60_000),
    );
  else complete(thread, turn);
}
function diffPreviewScenario(thread: Thread, turn: Turn, scenario: string): void {
  const changes = diffPreviewChanges(scenario);
  const item: ThreadItem = { id: randomUUID(), type: 'fileChange', status: 'completed', changes };
  turn.items.push(item);
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
  });
  notify({
    method: 'turn/diff/updated',
    params: {
      threadId: thread.id,
      turnId: turn.id,
      diff: changes.map((change) => change.diff).join(''),
    },
  });
  complete(thread, turn);
}

function execute(thread: Thread, turn: Turn, cmd = command(randomUUID(), thread.cwd)): void {
  if (turn.items.some((item) => item.type === 'enteredReviewMode')) {
    finishes.set(
      turn.id,
      setTimeout(() => {
        if (turn.status !== 'inProgress') return;
        const result: ThreadItem = {
          id: randomUUID(),
          type: 'exitedReviewMode',
          review: '## 代码审查结果\n\n模拟审查已完成：未提交改动中未发现需要修复的问题。',
        };
        turn.items.push(result);
        notify({
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item: result, completedAtMs: Date.now() },
        });
        complete(thread, turn);
      }, options.turnDelayMs ?? 150),
    );
    return;
  }
  turn.items.push(cmd);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, startedAtMs: Date.now() },
  });
  const output = '你好 Codex\n' + 'x'.repeat(options.outputBytes ?? 0);
  for (let offset = 0; offset < output.length; offset += 8192)
    notify({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        itemId: cmd.id,
        delta: output.slice(offset, offset + 8192),
      },
    });
  cmd.aggregatedOutput = output;
  cmd.status = 'completed';
  cmd.exitCode = 0;
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, completedAtMs: Date.now() },
  });
  const diff = '--- a/hello.txt\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+你好 Codex\n';
  const file: ThreadItem = {
    id: randomUUID(),
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: 'hello.txt', kind: { type: 'add' }, diff }],
  };
  turn.items.push(file);
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item: file, completedAtMs: Date.now() },
  });
  notify({ method: 'turn/diff/updated', params: { threadId: thread.id, turnId: turn.id, diff } });
  const item: ThreadItem = {
    id: randomUUID(),
    type: 'agentMessage',
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  notify({
    method: 'item/agentMessage/delta',
    params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: '模拟任务已完成。' },
  });
  item.text = '模拟任务已完成。';
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
  });
  finishes.set(
    turn.id,
    setTimeout(() => complete(thread, turn), options.turnDelayMs ?? 100),
  );
}
function imageReply(
  thread: Thread,
  turn: Turn,
  variant: 'normal' | 'errors' | 'temporary' | 'remote' | 'remote-errors',
): void {
  const absolute = join(thread.cwd, 'assets/发布 图表.png');
  const temporaryDirectory = `codex-local-image-${thread.id}`;
  const systemImage = join(tmpdir(), temporaryDirectory, '临时 图.png');
  const text = {
    remote:
      '远程图片可以直接查看，点击缩略图可放大。\n\n' +
      '![桌面复制效果](https://github.com/user-attachments/assets/04aaa811-cdeb-45e0-a303-0619761552f1)\n\n' +
      '![跨域跳转图片](https://images.example.test/asset?name=preview&version=2)\n\n' +
      '[![带链接的图片](https://images.example.test/linked)](https://example.com/docs)',
    'remote-errors':
      '图片暂时无法显示，可以重试或打开原图检查。\n\n' +
      ['missing', 'refused', 'offline', 'corrupt']
        .map((name) => `![${name}](https://images.example.test/${name})`)
        .join('\n\n'),
    temporary:
      '图片已保存在服务器临时目录中，仍可直接查看和放大。\n\n' +
      `![服务器临时图片](<${systemImage}>)\n\n` +
      `[临时文件 URL 图片](${pathToFileURL(systemImage).href})` +
      (process.platform === 'win32'
        ? ''
        : ` · [标准 tmp 图片](<${join('/tmp', temporaryDirectory, '临时 图.png')}>)`),
    errors:
      '以下图片暂时无法预览，原始路径仍可查看：\n\n' +
      '![缺失截图](<assets/不存在 截图.png>)\n\n' +
      '![不支持的矢量图](assets/diagram.svg)\n\n' +
      '![损坏图片](assets/broken.png)\n\n' +
      '![无法解码的图片](assets/undecodable.png)\n\n' +
      '[查看缺失截图](<assets/不存在 截图.png>)',
    normal:
      '已生成项目进度图。点击图片可放大查看，图片链接也可直接预览。\n\n' +
      '![项目进度图](<./assets/发布 图表.png>)\n\n' +
      `[绝对路径图片](<${absolute}>) · ` +
      `[文件 URL 图片](${pathToFileURL(absolute).href}) · ` +
      '[JPEG 图片](assets/preview.jpg) · [WebP 图片](assets/preview.webp) · [GIF 图片](assets/preview.gif)\n\n' +
      '[普通文件](assets/notes.txt) · [外部说明](https://example.com/docs)',
  }[variant];
  const item: ThreadItem = {
    id: randomUUID(),
    type: 'agentMessage',
    text,
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  turn.items.push(item);
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
  });
  finishes.set(
    turn.id,
    setTimeout(() => complete(thread, turn), options.turnDelayMs ?? 100),
  );
}

function markdownReply(
  thread: Thread,
  turn: Turn,
  kind: 'table' | 'security' | 'code' | 'files' | 'json' | 'mermaid' | 'text',
): void {
  const item: Extract<ThreadItem, { type: 'agentMessage' }> = {
    id: randomUUID(),
    type: 'agentMessage',
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  let chunks =
    kind === 'files'
      ? [
          '方案已整理好，可以打开文档边读边继续讨论。\n\n' +
            '[阅读实施方案](<docs/实施 方案.md>) · [绝对路径](<' +
            join(thread.cwd, 'docs/实施 方案.md') +
            '>) · [本地文件](file://' +
            encodeURI(join(thread.cwd, 'docs/实施 方案.md')) +
            ')\n\n' +
            '[缺失文档](docs/missing.md) · [外部文档](https://example.com/README.md)\n\n' +
            Array.from(
              { length: 12 },
              (_, i) => '检查项 ' + (i + 1) + '：阅读文档后，可以继续补充要求。',
            ).join('\n\n'),
        ]
      : kind === 'code'
        ? [
            '下面的路径、命令和 Markdown 原文都可以直接复制。行内代码 `pnpm test` 保持原样。\n\n' +
              '```\n/Users/demo/projects/codex-web-ui/src/main.ts\n```\n\n' +
              '```bash\npnpm build\n',
            '  pnpm test -- --run\n\tprintf "你好 & <Codex>"\n\n```\n\n' +
              '````markdown\n# 部署步骤\n\n- **保留 Markdown 原文**\n\n```sh\npnpm start\n```\n````\n\n',
            '```ts\nconst endpoint = "https://example.com/api/projects/abcdefghijklmnopqrstuvwxyz/threads/abcdefghijklmnopqrstuvwxyz/messages?include=content&format=markdown";\n```',
          ]
        : kind === 'security'
          ? [
              '~~已替换的方案~~\n\n- [x] 表格渲染\n- [ ] 后续优化\n\n' +
                '[正常链接](https://example.com/docs)\n\n' +
                '[危险链接](javascript:alert%281%29)\n\n' +
                '<script>window.markdownInjected = true</script>\n\n' +
                '<img src="x" onerror="window.markdownInjected = true">\n\n' +
                '```text\n| 这不是 | 表格 |\n| --- | --- |\n```',
            ]
          : kind === 'json'
            ? [
                'JSON 产出已准备好，可以直接预览并继续讨论。\n\n' +
                  '[配置文件](<docs/项目 配置.JSON>) · [数组](docs/list.json) · [使用说明](docs/json.md)\n\n' +
                  '[无效 JSON](docs/invalid.json) · [缺失文件](docs/missing.json) · [超大文件](docs/huge.json)\n\n' +
                  '[绝对路径](<' +
                  join(thread.cwd, 'docs/项目 配置.JSON') +
                  '>) · ' +
                  '[本地文件](file://' +
                  encodeURI(join(thread.cwd, 'docs/项目 配置.JSON')) +
                  ')',
              ]
            : [
                '我建议优先做下面几组，按当前支持情况排序：\n\n' +
                  '| 优先级 | 命令 | 为什么值得做 |\n| :',
                '--- | :---: | ---: |\n' +
                  '| **第一批** | `/rename` | 会话多了很实用，已有标题写入基础。 |\n',
                '| **第一批** | `/model`、`/permissions` | 高频操作，可复用现有设置控件。 |\n' +
                  '| **第一批** | `/copy`、`/export` | Copy & export，保存和分享对话，尤其适合手机端。 |\n' +
                  '| 第二批 | `/review`、`/diff` | 补齐“修改代码 → 查看改动 → 审查”的工作流程。 |\n' +
                  '| 后续 | `a\\|b` | 支持转义管道 A\\|B，并保留 **重点** 与 [说明](https://example.com/docs)。 |\n\n' +
                  '下一轮我会先选 `/rename`、`/model`、`/copy`，范围清楚，收益直接。',
              ];
  if (kind === 'text')
    chunks = [
      '文本产出已准备好，可以直接阅读并继续讨论。\n\n' +
        '[阅读文本](<docs/阅读 说明.TXT>) · [使用说明](docs/text.md) · ' +
        '[绝对路径](<' +
        join(thread.cwd, 'docs/阅读 说明.TXT') +
        '>) · ' +
        '[本地文件](file://' +
        encodeURI(join(thread.cwd, 'docs/阅读 说明.TXT')) +
        ')\n\n' +
        '[空文件](docs/empty.txt) · [缺失文件](docs/missing.txt) · [超大文件](docs/huge.txt) · [无效编码](docs/binary.txt)\n\n' +
        ['csv', 'tsv', 'toml', 'yaml', 'yml', 'jsonl', 'log', 'ini']
          .map((extension) => `[${extension.toUpperCase()}](docs/sample.${extension})`)
          .join(' · '),
    ];
  if (kind === 'mermaid') chunks = mermaidChunks;
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  const stream = (index: number) => {
    if (turn.status !== 'inProgress') return;
    const delta = chunks[index]!;
    item.text += delta;
    notify({
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta },
    });
    finishes.set(
      turn.id,
      setTimeout(
        () => {
          if (turn.status !== 'inProgress') return;
          if (index + 1 < chunks.length) stream(index + 1);
          else {
            notify({
              method: 'item/completed',
              params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
            });
            complete(thread, turn);
          }
        },
        kind === 'mermaid' ? 2000 : 1200,
      ),
    );
  };
  stream(0);
}
/** A failed invocation stays visible while its retry succeeds or the turn itself fails. */
function activityRetryScenario(thread: Thread, turn: Turn, failTurn: boolean): void {
  const publish = (item: ThreadItem, started = false) => {
    const params = { threadId: thread.id, turnId: turn.id, item };
    if (started) notify({ method: 'item/started', params: { ...params, startedAtMs: Date.now() } });
    else notify({ method: 'item/completed', params: { ...params, completedAtMs: Date.now() } });
  };
  const failed = command(randomUUID(), thread.cwd);
  failed.command = 'pnpm test';
  failed.status = 'failed';
  failed.exitCode = 1;
  failed.aggregatedOutput = 'Error: test service temporarily unavailable. Retrying…';
  const succeeded = command(randomUUID(), thread.cwd);
  succeeded.command = 'git diff --check';
  succeeded.status = 'completed';
  succeeded.exitCode = 0;
  succeeded.aggregatedOutput = 'No whitespace errors.';
  const retry = command(randomUUID(), thread.cwd);
  retry.command = 'pnpm test';
  retry.aggregatedOutput = 'Retrying test service…';
  turn.items.push(failed, succeeded, retry);
  publish(failed);
  publish(succeeded);
  publish(retry, true);
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status !== 'inProgress') return;
      retry.status = failTurn ? 'failed' : 'completed';
      retry.exitCode = failTurn ? 1 : 0;
      retry.aggregatedOutput = failTurn ? 'Error: retry exhausted.' : 'All tests passed on retry.';
      publish(retry);
      if (failTurn)
        turn.error = {
          message: '任务失败：重试后测试服务仍不可用。',
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        };
      complete(thread, turn, failTurn ? 'failed' : 'completed');
    }, 4000),
  );
}

/** A long response lets browser tests read earlier output while later deltas arrive. */
function stickyPromptReply(thread: Thread, turn: Turn, streaming: boolean): void {
  const item: Extract<ThreadItem, { type: 'agentMessage' }> = {
    id: randomUUID(),
    type: 'agentMessage',
    text: Array.from(
      { length: 48 },
      (_, index) =>
        `### 检查项 ${index + 1}\n\n核对当前轮次的用户要求，并在阅读回复和执行过程时保留上下文。确认布局稳定、内容可读，以及窄屏上的交互可用。`,
    ).join('\n\n'),
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  const finish = () => {
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
    });
    complete(thread, turn);
  };
  if (!streaming) return finish();
  let update = 0;
  const append = () => {
    if (turn.status !== 'inProgress') return;
    const delta = `\n\n流式补充 ${++update}：继续验证页面保持当前阅读位置。`;
    item.text += delta;
    notify({
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta },
    });
    if (update < 2) finishes.set(turn.id, setTimeout(append, 2000));
    else finish();
  };
  finishes.set(turn.id, setTimeout(append, 2000));
}

/** Command outputs retain interleaved stdout/stderr, whitespace and empty results. */
function commandOutputScenario(thread: Thread, turn: Turn, truncated: boolean): void {
  const outputs = truncated
    ? ['Loaded output\n' + 'x'.repeat(2 * 1024 * 1024) + '\nnot retained\n']
    : [
        'stdout: 你好 & <Covro>\r\n  indented line\n\ttabbed line\n\n',
        'stdout: starting\nstderr: Error: unavailable\nstdout: cleanup complete\n',
        '',
      ];
  for (const [index, output] of outputs.entries()) {
    const item = command(randomUUID(), thread.cwd);
    item.command = index === 1 ? 'node failing-command.mjs' : `node example-${index + 1}.mjs`;
    item.aggregatedOutput = output;
    item.status = index === 1 ? 'failed' : 'completed';
    item.exitCode = index === 1 ? 1 : 0;
    turn.items.push(item);
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
    });
  }
  complete(thread, turn);
}

/** Real protocol events for long, independent activities and streamed rerenders. */
function activityScenario(thread: Thread, turn: Turn, streaming: boolean, mixed = false): void {
  const finishedItem = (item: ThreadItem) => {
    turn.items.push(item);
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
    });
  };
  const message = (text: string, phase: 'commentary' | 'final_answer' = 'commentary') =>
    finishedItem({
      id: randomUUID(),
      type: 'agentMessage',
      text,
      phase,
      memoryCitation: null,
      delivery: null,
      questions: null,
    });
  const output = (label: string) =>
    Array.from(
      { length: 140 },
      (_, index) => `${label} ${String(index + 1).padStart(3, '0')}: passed`,
    ).join('\n') + '\n';
  const file = (path: string) => {
    const diff = [
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,100 +1,100 @@',
      ...Array.from({ length: 100 }, (_, index) => [
        `-export const previousValue${index + 1} = 'before';`,
        `+export const updatedValue${index + 1} = 'after';`,
      ]).flat(),
    ].join('\n');
    finishedItem({
      id: randomUUID(),
      type: 'fileChange',
      status: 'completed',
      changes: [{ path, kind: { type: 'update', move_path: null }, diff }],
    });
  };
  message('先运行完整测试，再检查文件变更。');
  if (mixed)
    for (const status of ['approved', 'denied', 'timedOut', 'aborted'] as const) {
      const common = {
        threadId: thread.id,
        turnId: turn.id,
        reviewId: randomUUID(),
        targetItemId: randomUUID(),
        startedAtMs: Date.now(),
        action: {
          type: 'command' as const,
          source: 'unifiedExec' as const,
          command: `检查 ${status} 审核摘要`,
          cwd: thread.cwd,
        },
      };
      notify({
        method: 'item/autoApprovalReview/started',
        params: {
          ...common,
          review: {
            status: 'inProgress',
            riskLevel: null,
            userAuthorization: null,
            rationale: null,
          },
        },
      });
      notify({
        method: 'item/autoApprovalReview/completed',
        params: {
          ...common,
          completedAtMs: Date.now(),
          decisionSource: 'agent',
          review: {
            status,
            riskLevel: null,
            userAuthorization: null,
            rationale: '用于检查摘要换行。',
          },
        },
      });
    }
  const first = command(randomUUID(), thread.cwd);
  first.command = 'pnpm test -- --reporter=verbose';
  first.aggregatedOutput = output('unit-test');
  turn.items.push(first);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item: first, startedAtMs: Date.now() },
  });
  const finish = () => {
    first.status = 'completed';
    first.exitCode = 0;
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item: first, completedAtMs: Date.now() },
    });
    file('src/activity-summary.ts');
    message('第一轮检查完成。下面单独运行构建并检查另一处文件变更。');
    const second = command(randomUUID(), thread.cwd);
    second.command = 'pnpm build -- --mode=production';
    second.aggregatedOutput = output('build-module');
    second.status = 'completed';
    second.exitCode = 0;
    finishedItem(second);
    file('src/activity-details.ts');
    // Enough following content to scroll every activity entirely out of the viewport.
    message(
      '所有检查完成。\n\n' +
        Array.from(
          { length: 24 },
          (_, index) => `检查说明 ${index + 1}：测试与构建均已完成，可以继续阅读后续回复。`,
        ).join('\n\n'),
      'final_answer',
    );
    complete(thread, turn);
  };
  if (!streaming) {
    finish();
    return;
  }
  for (const [index, delay] of [2000, 4000].entries()) {
    setTimeout(() => {
      if (turn.status !== 'inProgress') return;
      const delta = `stream-update-${index + 1}: more test results arrived\n`;
      first.aggregatedOutput += delta;
      notify({
        method: 'item/commandExecution/outputDelta',
        params: { threadId: thread.id, turnId: turn.id, itemId: first.id, delta },
      });
    }, delay);
  }
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status === 'inProgress') finish();
    }, 6000),
  );
}
/** Automatic compaction stays inside the current task; no compact RPC is involved. */
function contextCompaction(thread: Thread, turn: Turn, outcome: 'recover' | 'fail' | 'hold'): void {
  const item: ThreadItem = { type: 'contextCompaction', id: randomUUID() };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  if (outcome === 'hold') return;
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status !== 'inProgress') return;
      if (outcome === 'fail') {
        turn.error = {
          message: '上下文压缩请求失败：模型服务暂时不可用。',
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        };
        notify({
          method: 'error',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            error: turn.error,
            willRetry: false,
          },
        });
        complete(thread, turn, 'failed');
        return;
      }
      notify({
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item,
          completedAtMs: Date.now(),
        },
      });
      // Some versions also emit this deprecated notification. It must not create a second record.
      notify({ method: 'thread/compacted', params: { threadId: thread.id, turnId: turn.id } });
      const reply: ThreadItem = {
        id: randomUUID(),
        type: 'agentMessage',
        text: '已整理上下文，继续分析剩余实现与测试。',
        phase: 'commentary',
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      turn.items.push(reply);
      notify({
        method: 'item/started',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: reply,
          startedAtMs: Date.now(),
        },
      });
      finishes.set(
        turn.id,
        setTimeout(() => {
          if (turn.status !== 'inProgress') return;
          notify({
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item: reply,
              completedAtMs: Date.now(),
            },
          });
          complete(thread, turn);
        }, 5000),
      );
    }, 4000),
  );
}

function capacityScenario(thread: Thread, turn: Turn, mode: string): void {
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status !== 'inProgress') return;
      const continuation = !turn.items.some((item) => item.type === 'userMessage');
      if (mode === 'quote' || (continuation && (mode === 'recover' || mode === 'partial'))) {
        const item: ThreadItem = {
          id: randomUUID(),
          type: 'agentMessage',
          text: mode === 'quote' ? MODEL_CAPACITY_MESSAGE : '容量恢复，继续处理原任务。',
          phase: 'final_answer',
          memoryCitation: null,
          delivery: null,
          questions: null,
        };
        turn.items.push(item);
        notify({
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
        });
        complete(thread, turn);
        return;
      }
      if (mode === 'partial') {
        const item = command(randomUUID(), thread.cwd);
        item.status = 'completed';
        item.exitCode = 0;
        item.command = 'printf already-done';
        turn.items.push(item);
        notify({
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
        });
      }
      turn.error = {
        message: MODEL_CAPACITY_MESSAGE,
        codexErrorInfo: mode === 'other' ? 'badRequest' : 'serverOverloaded',
        additionalDetails: null,
        misalignment: null,
      };
      for (let i = 0; i < 2; i++)
        notify({
          method: 'error',
          params: { threadId: thread.id, turnId: turn.id, willRetry: false, error: turn.error },
        });
      complete(thread, turn, 'failed');
    }, 200),
  );
}

function codexReconnect(
  thread: Thread,
  turn: Turn,
  outcome: 'recover' | 'fail' | 'hold',
  capacity = false,
): void {
  const cmd = command(randomUUID(), thread.cwd);
  cmd.command = '读取已有任务的后台输出';
  turn.items.push(cmd);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, startedAtMs: Date.now() },
  });
  const retry = (attempt: number) =>
    notify({
      method: 'error',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        willRetry: true,
        error: {
          message: `Reconnecting... ${attempt}/5 (stream disconnected before completion)`,
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: capacity ? MODEL_CAPACITY_MESSAGE : null,
          misalignment: null,
        },
      },
    });
  const later = (delay: number, work: () => void) =>
    setTimeout(() => {
      // An interrupted turn must never be revived by a queued simulator notification.
      if (turn.status === 'inProgress') work();
    }, delay);
  retry(1);
  later(600, () => {
    cmd.aggregatedOutput = '重连期间到达的后台工具输出';
    notify({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        itemId: cmd.id,
        delta: cmd.aggregatedOutput,
      },
    });
  });
  later(900, () => {
    cmd.status = 'completed';
    cmd.exitCode = 0;
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item: cmd, completedAtMs: Date.now() },
    });
  });
  later(1400, () => retry(2));
  if (outcome === 'hold') return;
  finishes.set(
    turn.id,
    later(4000, () => {
      if (outcome === 'fail') {
        turn.error = {
          message: 'stream disconnected before completion: exceeded retry limit',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
          additionalDetails: capacity ? MODEL_CAPACITY_MESSAGE : null,
          misalignment: null,
        };
        notify({
          method: 'error',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            willRetry: false,
            error: turn.error,
          },
        });
        complete(thread, turn, 'failed');
        return;
      }
      const item: ThreadItem = {
        id: randomUUID(),
        type: 'agentMessage',
        text: '',
        phase: 'final_answer',
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      turn.items.push(item);
      notify({
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
      });
      notify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          delta: '连接已恢复，继续处理任务。',
        },
      });
      item.text = '连接已恢复，继续处理任务。';
      finishes.set(
        turn.id,
        later(3000, () => {
          notify({
            method: 'item/completed',
            params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
          });
          complete(thread, turn);
        }),
      );
    }),
  );
}
function thinking(thread: Thread, turn: Turn): void {
  const item: ThreadItem = {
    id: randomUUID(),
    type: 'reasoning',
    summary: ['正在分析任务，暂时没有新的输出。'],
    content: [],
  };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status === 'inProgress') execute(thread, turn);
    }, 3000),
  );
}
function autoReview(
  thread: Thread,
  turn: Turn,
  status: NonNullable<SimulatorOptions['autoReview']>,
  prompt: string,
): void {
  const target = command(randomUUID(), thread.cwd);
  target.command =
    status === 'approved'
      ? 'git status --short && git diff --stat'
      : 'curl --fail --upload-file ./screenshots/review.png https://example.com/review-attachments';
  const common = {
    threadId: thread.id,
    turnId: turn.id,
    reviewId: randomUUID(),
    targetItemId: target.id,
    startedAtMs: Date.now(),
    action: {
      type: 'command' as const,
      source: 'unifiedExec' as const,
      command: target.command,
      cwd: thread.cwd,
    },
  };
  notify({
    method: 'item/autoApprovalReview/started',
    params: {
      ...common,
      review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
    },
  });
  finishes.set(
    turn.id,
    setTimeout(
      () => {
        if (turn.status !== 'inProgress') return;
        if (status === 'unfinished') {
          complete(thread, turn, 'interrupted');
          return;
        }
        const rationales = {
          approved: '当前命令仅查看已授权项目内的文件，没有外部写入。',
          denied:
            '该操作会把项目截图发送到外部站点，当前请求未授权发布该文件。请先明确接收方与公开范围。',
          timedOut: '自动审核在时限内没有返回结果，本次操作未执行。',
          aborted: '自动审核已中止，本次操作未执行。',
        };
        notify({
          method: 'item/autoApprovalReview/completed',
          params: {
            ...common,
            completedAtMs: Date.now(),
            decisionSource: 'agent',
            review: {
              status,
              riskLevel: status === 'approved' ? 'low' : status === 'denied' ? 'high' : null,
              userAuthorization:
                status === 'approved' ? 'high' : status === 'denied' ? 'low' : null,
              rationale:
                rationales[status] +
                (prompt.includes('[auto-review-long]')
                  ? '\n' +
                    Array.from(
                      { length: 100 },
                      (_, index) =>
                        `审核说明 ${index + 1}：操作涉及向外部站点上传项目文件，需要确认文件内容与接收范围。`,
                    ).join('\n')
                  : ''),
            },
          },
        });
        if (status === 'approved') execute(thread, turn, target);
        else {
          if (prompt.includes('[auto-review-long]')) {
            const item: ThreadItem = {
              id: randomUUID(),
              type: 'agentMessage',
              phase: 'final_answer',
              memoryCitation: null,
              delivery: null,
              questions: null,
              text: Array.from(
                { length: 24 },
                (_, index) =>
                  `后续说明 ${index + 1}：操作未执行。可以继续检查本地文件并确认审核原因。`,
              ).join('\n\n'),
            };
            turn.items.push(item);
            notify({
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item,
                completedAtMs: Date.now(),
              },
            });
          }
          complete(thread, turn, 'interrupted');
        }
      },
      options.autoReviewDelayMs ?? (prompt.includes('[auto-review-slow]') ? 4000 : 1500),
    ),
  );
}
function approval(
  thread: Thread,
  turn: Turn,
  kind: NonNullable<SimulatorOptions['approval']>,
): void {
  const id = nextRequestId++;
  const common = { threadId: thread.id, turnId: turn.id, itemId: randomUUID() };
  let request: ServerRequest;
  if (kind === 'questions' || kind === 'questions-choice')
    request = {
      id,
      method: 'item/tool/requestUserInput',
      params: {
        ...common,
        isBlocking: !options.nonblockingQuestions,
        autoResolutionMs: null,
        questions:
          kind === 'questions-choice'
            ? [
                {
                  id: 'confirmation',
                  header: '操作确认',
                  question: '是否允许执行这次操作？请选择，也可以填写其他回答。',
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: '允许本次', description: '只确认本次操作' },
                    { label: '本会话允许', description: '确认当前会话范围' },
                    { label: '拒绝', description: '不执行操作' },
                  ],
                },
              ]
            : [
                {
                  id: 'theme',
                  header: '主题',
                  question: '选择主题',
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: '深色', description: '深色界面' },
                    { label: '浅色', description: '浅色界面' },
                  ],
                },
                {
                  id: 'name',
                  header: '名称',
                  question: '输入名称',
                  isOther: true,
                  isSecret: false,
                  options: null,
                },
              ],
      },
    };
  else if (kind === 'permissions')
    request = {
      id,
      method: 'item/permissions/requestApproval',
      params: {
        ...common,
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: thread.cwd,
        reason: '需要联网并保存截图附件，请确认权限范围。',
        permissions: options.permissions ?? {
          network: { enabled: true },
          fileSystem: {
            read: [`${thread.cwd}/reference`],
            write: [`${thread.cwd}/report.txt`],
            globScanMaxDepth: 2,
            entries: [
              { path: { type: 'path', path: `${thread.cwd}/screenshots` }, access: 'write' },
            ],
          },
        },
      },
    };
  else if (kind.startsWith('elicitation-')) {
    const context = {
      threadId: thread.id,
      turnId: options.elicitationTurnId === null ? null : turn.id,
      serverName: '截图发布服务',
      _meta:
        options.elicitationMeta ??
        (['elicitation-approval', 'elicitation-session', 'elicitation-session-array'].includes(kind)
          ? {
              codex_approval_kind: 'mcp_tool_call',
              ...(kind === 'elicitation-session'
                ? { persist: 'session' }
                : kind === 'elicitation-session-array'
                  ? { persist: ['always', 'session'] }
                  : {}),
            }
          : null),
      message: [
        'elicitation-approval',
        'elicitation-session',
        'elicitation-session-array',
      ].includes(kind)
        ? '允许截图发布服务调用上传附件工具，将本次截图贴到 GitHub PR 评论？'
        : '请确认截图发布设置，只有提交后任务才会继续。',
    };
    const schema = Object.hasOwn(options, 'elicitationSchema')
      ? options.elicitationSchema
      : [
            'elicitation-confirm',
            'elicitation-approval',
            'elicitation-session',
            'elicitation-session-array',
          ].includes(kind)
        ? { type: 'object', properties: {} }
        : kind === 'elicitation-choice'
          ? {
              type: 'object',
              properties: { allow: { type: 'boolean', title: '是否允许执行本次操作' } },
              required: ['allow'],
            }
          : kind === 'elicitation-malformed'
            ? { type: 'object', properties: { nested: { type: 'object', properties: {} } } }
            : {
                type: 'object',
                properties: {
                  project: { type: 'string', title: '项目名称', minLength: 2, maxLength: 60 },
                  retries: { type: 'integer', title: '重试次数', minimum: 0, maximum: 5 },
                  rating: { type: 'number', title: '评分', minimum: 0, maximum: 10 },
                  notify: { type: 'boolean', title: '启用通知' },
                  environment: {
                    type: 'string',
                    title: '环境',
                    oneOf: [
                      { const: 'production', title: '生产' },
                      { const: 'preview', title: '预览' },
                    ],
                  },
                  channels: {
                    type: 'array',
                    title: '发布渠道',
                    minItems: 1,
                    maxItems: 2,
                    items: {
                      anyOf: [
                        { const: 'web', title: '网页' },
                        { const: 'mobile', title: '移动端' },
                      ],
                    },
                  },
                  note: { type: 'string', title: '备注' },
                },
                required: ['project', 'retries', 'rating', 'notify', 'environment', 'channels'],
              };
    request = {
      id,
      method: 'mcpServer/elicitation/request',
      params:
        kind === 'elicitation-url'
          ? {
              ...context,
              mode: 'url',
              url: 'https://example.com/authorize?service=screenshots',
              elicitationId: `elicitation-${id}`,
            }
          : kind === 'elicitation-openai'
            ? { ...context, mode: 'openai/form', requestedSchema: schema as JsonValue }
            : kind === 'elicitation-openai-form'
              ? { ...context, mode: 'openaiForm', requestedSchema: schema as JsonValue }
              : { ...context, mode: 'form', requestedSchema: schema as McpElicitationSchema },
    };
  } else if (kind === 'file')
    request = {
      id,
      method: 'item/fileChange/requestApproval',
      params: {
        ...common,
        startedAtMs: Date.now(),
        reason: '需要写入测试文件',
        grantRoot: thread.cwd,
      },
    };
  else if (kind === 'unsupported') {
    send({ id, method: 'future/requestApproval', params: common });
    callbacks.set(id, () => complete(thread, turn, 'interrupted'));
    return;
  } else
    request = {
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        ...common,
        kind: 'command',
        startedAtMs: Date.now(),
        environmentId: null,
        reason: '执行测试命令',
        ...(kind === 'network'
          ? { networkApprovalContext: { host: 'example.com', protocol: 'https' } }
          : { command: 'printf "你好 Codex"', cwd: thread.cwd }),
      },
    };
  thread.status = {
    type: 'active',
    activeFlags:
      kind.startsWith('questions') && options.nonblockingQuestions
        ? []
        : [
            kind.startsWith('questions') || kind.startsWith('elicitation-')
              ? 'waitingOnUserInput'
              : 'waitingOnApproval',
          ],
  };
  notify({
    method: 'thread/status/changed',
    params: { threadId: thread.id, status: thread.status },
  });
  send(request);
  callbacks.set(id, (response) => {
    notify({ method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: id } });
    thread.status = { type: 'active', activeFlags: [] };
    if (kind === 'permissions' || kind.startsWith('elicitation-')) {
      const result = response.result as Record<string, unknown> | undefined;
      const accepted =
        kind === 'permissions'
          ? result?.permissions && Object.keys(result.permissions).length > 0
          : result?.action === 'accept';
      if (!accepted || response.error) {
        complete(thread, turn, 'interrupted');
        return;
      }
    }
    execute(thread, turn);
  });
}
const model: Model = {
  id: 'simulated-model',
  model: 'simulated-model',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: '模拟模型',
  description: '仅供自动测试，不发起真实推理',
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'none', description: 'None' },
    { reasoningEffort: 'minimal', description: 'Minimal' },
    { reasoningEffort: 'low', description: 'Low' },
    { reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'high', description: 'High' },
    { reasoningEffort: 'xhigh', description: 'Extra high' },
    { reasoningEffort: 'max', description: 'Maximum' },
    { reasoningEffort: 'ultra', description: 'Ultra' },
  ],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: true,
};
const delayedStarts = new WeakSet<ClientRequest>();
// Only the explicit test simulator runs host commands; production uses Codex's sandbox.
const shellProcesses = new Map<string, ChildProcess>();
function stopShell(child: ChildProcess) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  } else child.kill('SIGKILL');
}
function stopShells() {
  for (const child of shellProcesses.values()) stopShell(child);
}
function receive(request: ClientRequest): void {
  if (request.method === 'initialize') {
    if (options.initializeFailureOncePath && !existsSync(options.initializeFailureOncePath)) {
      writeFileSync(options.initializeFailureOncePath, 'failed');
      error(request.id, 'Temporary initialization failure', -32000);
      return;
    }
    initialized = true;
    reply(request.id, {
      userAgent: `codex/${CODEX_COMPATIBILITY.recommended}`,
      codexHome: '/tmp/simulated-codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    } satisfies InitializeResponse);
    return;
  }
  if (!initialized || !handshaken) {
    error(request.id, 'Handshake incomplete', -32000);
    return;
  }
  if (request.method === options.unsupportedMethod) {
    error(request.id, 'Method not found', -32601);
    return;
  }
  switch (request.method) {
    case 'command/exec': {
      const params = request.params;
      const child = spawn(params.command[0]!, params.command.slice(1), {
        cwd: params.cwd ?? undefined,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const processId = params.processId!;
      shellProcesses.set(processId, child);
      const timer = setTimeout(() => stopShell(child), params.timeoutMs ?? 60_000);
      const captured = { stdout: 0, stderr: 0 };
      for (const stream of ['stdout', 'stderr'] as const)
        child[stream]!.on('data', (bytes: Buffer) => {
          const cap = params.outputBytesCap ?? 32768;
          const remaining = Math.max(0, cap - captured[stream]);
          if (!remaining) return;
          captured[stream] += bytes.length;
          notify({
            method: 'command/exec/outputDelta',
            params: {
              processId,
              stream,
              deltaBase64: bytes.subarray(0, remaining).toString('base64'),
              capReached: captured[stream] >= cap,
            },
          });
        });
      child.once('error', (failure) => error(request.id, failure.message, -32000));
      child.once('close', (code) => {
        clearTimeout(timer);
        shellProcesses.delete(processId);
        reply(request.id, { exitCode: code ?? 137, stdout: '', stderr: '' });
      });
      break;
    }
    case 'command/exec/terminate': {
      const child = shellProcesses.get(request.params.processId);
      if (child) stopShell(child);
      reply(request.id, {});
      break;
    }
    case 'account/read':
      reply(request.id, {
        account:
          options.accountType === 'chatgpt'
            ? { type: 'chatgpt', email: null, planType: 'plus' }
            : options.accountType === 'apiKey'
              ? { type: 'apiKey' }
              : null,
        requiresOpenaiAuth: false,
      });
      break;
    case 'config/read':
      reply(request.id, {
        config: {
          mcp_servers: { 'fixture.tools': { command: 'unused', enabled: true } },
          model:
            savedModelDefaults?.model ??
            (options.configModel === undefined ? 'simulated-model' : options.configModel),
          service_tier: null,
          model_reasoning_effort: savedModelDefaults
            ? savedModelDefaults.effort
            : options.configEffort === undefined
              ? request.params.cwd?.endsWith('other-project')
                ? 'high'
                : 'medium'
              : options.configEffort,
          sandbox_mode: 'read-only',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          developer_instructions: 'private instructions',
          api_key: 'private-test-key',
          ...options.configOverrides,
        },
        origins: {},
        layers: null,
      });
      break;
    case 'config/batchWrite': {
      if (options.configWriteFailure) {
        error(request.id, 'Fixture configuration is not writable');
        break;
      }
      const selectedModel = request.params.edits.find((edit) => edit.keyPath === 'model')?.value;
      const effort = request.params.edits.find(
        (edit) => edit.keyPath === 'model_reasoning_effort',
      )?.value;
      if (typeof selectedModel !== 'string' || (effort !== null && typeof effort !== 'string')) {
        error(request.id, 'Expected a complete model selection');
        break;
      }
      savedModelDefaults = { model: selectedModel, effort: effort as ReasoningEffort | null };
      reply(request.id, {
        status: options.configWriteStatus ?? 'ok',
        version: randomUUID(),
        filePath: join(tmpdir(), 'fixture-user-config.toml'),
        overriddenMetadata: null,
      });
      break;
    }
    case 'configRequirements/read':
      reply(request.id, { requirements: options.requirements ?? null });
      break;
    case 'experimentalFeature/list':
      if (options.settingsOnFeatureRead && request.params.threadId) {
        const thread = threads.get(request.params.threadId);
        if (thread) notifySettings(thread);
      }
      reply(request.id, {
        data: [
          {
            name: 'guardian_approval',
            stage: 'stable',
            enabled: options.guardianApproval !== false,
            defaultEnabled: true,
            displayName: null,
            description: null,
            announcement: null,
          },
        ],
        nextCursor: null,
      });
      break;
    case 'model/list':
      reply(request.id, {
        data: (options.models ?? [model.model]).map((name) => ({
          ...model,
          id: name,
          model: name,
        })),
        nextCursor: null,
      });
      break;
    case 'thread/start': {
      if (options.rejectPermissions && (request.params as PermissionSelection).permissions) {
        error(request.id, 'Managed policy rejected permission selection');
        break;
      }
      const thread = makeThread(request.params.cwd ?? process.cwd());
      thread.ephemeral = request.params.ephemeral ?? false;
      thread.modelProvider = request.params.modelProvider ?? thread.modelProvider;
      applySettings(thread, request.params);
      threads.set(thread.id, thread);
      if (options.activeArchiveDescendant && !thread.ephemeral) {
        const child = makeThread(thread.cwd);
        child.parentThreadId = thread.id;
        child.status = { type: 'active', activeFlags: [] };
        threads.set(child.id, child);
      }
      const started = () =>
        notify({ method: 'thread/started', params: { thread: { ...thread, turns: [] } } });
      if (options.threadStartedDelayMs) setTimeout(started, options.threadStartedDelayMs);
      else started();
      reply(request.id, startResponse(thread));
      if (options.history && !thread.ephemeral) {
        thread.turns = Array.from({ length: options.history.turns }, () => ({
          id: randomUUID(),
          rootTurnId: null,
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          items: Array.from({ length: options.history!.itemsPerTurn }, () => ({
            ...command(randomUUID(), thread.cwd),
            status: 'completed' as const,
            aggregatedOutput: 'x'.repeat(options.history!.itemBytes),
          })),
        }));
      }
      break;
    }
    case 'thread/loaded/list':
      reply(request.id, {
        data: [...threads.values()]
          .filter((thread) => thread.status.type !== 'notLoaded')
          .map((thread) => thread.id)
          .concat(options.vanishedLoadedThread ? ['vanished-helper'] : []),
        nextCursor: null,
      });
      break;
    case 'thread/list':
      reply(request.id, {
        data: [...threads.values()]
          .filter((thread) => !thread.ephemeral)
          .filter((thread) => archived.has(thread.id) === Boolean(request.params.archived))
          .filter(
            (thread) =>
              !request.params.cwd ||
              (Array.isArray(request.params.cwd)
                ? request.params.cwd.includes(thread.cwd)
                : thread.cwd === request.params.cwd),
          )
          .map((thread) => ({ ...thread, turns: [] })),
        nextCursor: null,
      });
      break;
    case 'thread/name/set': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      const name = request.params.name;
      const write = () => {
        thread.name = name;
        notify({
          method: 'thread/name/updated',
          params: { threadId: thread.id, threadName: thread.name },
        });
        reply(request.id, {});
      };
      if (options.nameWriteDelayMs) setTimeout(write, options.nameWriteDelayMs);
      else write();
      break;
    }
    case 'thread/unsubscribe': {
      const thread = threads.get(request.params.threadId);
      reply(request.id, { status: 'unsubscribed' });
      if (thread?.ephemeral) {
        threads.delete(thread.id);
        notify({ method: 'thread/closed', params: { threadId: thread.id } });
      }
      break;
    }
    case 'thread/archive':
    case 'thread/unarchive': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      const archive = request.method === 'thread/archive';
      if (archive) {
        for (const turn of thread.turns)
          if (turn.status === 'inProgress') complete(thread, turn, 'interrupted');
        archived.add(thread.id);
        thread.status = { type: 'notLoaded' };
        notify({
          method: 'thread/status/changed',
          params: { threadId: thread.id, status: thread.status },
        });
      } else archived.delete(thread.id);
      reply(request.id, archive ? {} : { thread });
      notify({
        method: archive ? 'thread/archived' : 'thread/unarchived',
        params: { threadId: thread.id },
      });
      break;
    }
    case 'thread/read': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, `thread not loaded: ${request.params.threadId}`, -32600);
        break;
      }
      if (options.forkHistoryReadError && thread.forkedFromId) {
        error(request.id, 'Fork history temporarily unavailable', -32000);
        break;
      }
      reply(request.id, {
        thread: { ...thread, turns: request.params.includeTurns ? thread.turns : [] },
      });
      break;
    }
    case 'thread/fork': {
      const source = threads.get(request.params.threadId);
      if (!source) {
        error(request.id, 'Thread not found');
        break;
      }
      const thread = {
        ...makeThread(request.params.cwd ?? source.cwd),
        forkedFromId: source.id,
        preview: source.preview,
        name: source.name,
        turns: structuredClone(source.turns),
      };
      policies.set(thread.id, structuredClone(policy(source)));
      serviceTiers.set(thread.id, serviceTiers.get(source.id) ?? null);
      const inheritedProfile = profiles.get(source.id);
      if (inheritedProfile) profiles.set(thread.id, structuredClone(inheritedProfile));
      for (const turn of thread.turns) {
        if (turn.status === 'inProgress') {
          turn.status = 'interrupted';
          turn.completedAt = Date.now() / 1000;
        }
      }
      applySettings(thread, request.params);
      threads.set(thread.id, thread);
      notify({ method: 'thread/started', params: { thread: { ...thread, turns: [] } } });
      reply(request.id, {
        ...startResponse(thread),
        thread: options.malformedForkReceipt
          ? { id: thread.id, status: { type: 'futureStatus' }, cwd: thread.cwd, turns: [] }
          : { ...thread, turns: request.params.excludeTurns ? [] : thread.turns },
      });
      break;
    }
    case 'thread/resume': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      if (options.resumeFailure) {
        error(
          request.id,
          options.resumeFailure.message.replaceAll('{threadId}', thread.id),
          options.resumeFailure.code,
        );
        break;
      }
      applySettings(thread, request.params);
      if (thread.status.type === 'notLoaded') thread.status = { type: 'idle' };
      notify({
        method: 'thread/status/changed',
        params: { threadId: thread.id, status: thread.status },
      });
      reply(request.id, {
        ...startResponse(thread),
        thread: { ...thread, turns: request.params.excludeTurns ? [] : thread.turns },
        collaborationMode: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      });
      break;
    }
    case 'thread/turns/list': {
      const history = threads.get(request.params.threadId)?.turns ?? [];
      const turns = request.params.sortDirection === 'desc' ? history.slice().reverse() : history;
      const offset = Number(request.params.cursor ?? 0);
      const limit = Math.min(options.historyPageSize ?? 100, request.params.limit ?? 100);
      reply(request.id, {
        data: turns
          .slice(offset, offset + limit)
          .map((turn) =>
            options.historyItemSummaries || request.params.itemsView !== 'full'
              ? { ...turn, items: [], itemsView: 'summary' }
              : turn,
          ),
        nextCursor: offset + limit < turns.length ? String(offset + limit) : null,
        backwardsCursor: null,
      });
      break;
    }
    case 'thread/items/list': {
      const turn = threads
        .get(request.params.threadId)
        ?.turns.find((entry) => entry.id === request.params.turnId);
      const items = turn?.items ?? [];
      const offset = Number(request.params.cursor ?? 0);
      const limit = Math.min(options.historyPageSize ?? 100, request.params.limit ?? 100);
      reply(request.id, {
        data: items.slice(offset, offset + limit).map((item) => ({
          turnId: request.params.turnId,
          item,
          startedAtMs: null,
          completedAtMs: null,
        })),
        nextCursor: offset + limit < items.length ? String(offset + limit) : null,
        backwardsCursor: null,
      });
      break;
    }
    case 'thread/compact/start': {
      const thread = threads.get(request.params.threadId);
      if (!thread || thread.status.type === 'active') {
        error(request.id, thread ? 'Thread busy' : 'Thread not found');
        break;
      }
      const turn: Turn = {
        id: randomUUID(),
        rootTurnId: null,
        itemsView: 'full',
        items: [],
        status: 'inProgress',
        error: null,
        startedAt: Date.now() / 1000,
        completedAt: null,
        durationMs: null,
      };
      setTimeout(() => reply(request.id, {}), options.ackDelayMs ?? 0);
      setTimeout(() => {
        thread.turns.push(turn);
        thread.status = { type: 'active', activeFlags: [] };
        notify({ method: 'turn/started', params: { threadId: thread.id, turn } });
        const item: ThreadItem = { type: 'contextCompaction', id: randomUUID() };
        turn.items.push(item);
        notify({
          method: 'item/started',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item,
            startedAtMs: Date.now(),
          },
        });
        finishes.set(
          turn.id,
          setTimeout(() => {
            if (options.compactFailure)
              turn.error = {
                message: 'Compaction failed',
                codexErrorInfo: null,
                additionalDetails: null,
                misalignment: null,
              };
            notify({
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item,
                completedAtMs: Date.now(),
              },
            });
            complete(thread, turn, options.compactFailure ? 'failed' : 'completed');
          }, options.turnDelayMs ?? 800),
        );
      }, options.compactStartDelayMs ?? 0);
      break;
    }
    case 'review/start': {
      const thread = threads.get(request.params.threadId);
      if (!thread || thread.status.type === 'active') {
        error(request.id, thread ? 'Thread busy' : 'Thread not found');
        break;
      }
      if (options.reviewFailure) {
        error(request.id, options.reviewFailure);
        break;
      }
      if (options.crashAfterDispatch) process.exit(17);
      const item: ThreadItem = {
        id: randomUUID(),
        type: 'enteredReviewMode',
        review: '未提交改动',
      };
      const turn: Turn = {
        id: randomUUID(),
        rootTurnId: null,
        items: [item],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Date.now() / 1000,
        completedAt: null,
        durationMs: null,
      };
      thread.turns.push(turn);
      thread.status = { type: 'active', activeFlags: [] };
      notify({ method: 'turn/started', params: { threadId: thread.id, turn } });
      notify({
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
      });
      const receipt = structuredClone(turn);
      setTimeout(
        () =>
          reply(request.id, {
            turn: options.malformedTurnReceipt ? { ...receipt, status: 'invalid' } : receipt,
            reviewThreadId: options.reviewWrongThread ? 'unexpected-thread' : thread.id,
          }),
        options.ackDelayMs ?? 0,
      );
      if (options.approval) approval(thread, turn, options.approval);
      else execute(thread, turn);
      break;
    }
    case 'turn/start': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      if (thread.status.type === 'active') {
        error(request.id, 'Thread busy');
        break;
      }
      const text = request.params.input
        .flatMap((input) => (input.type === 'text' ? input.text : ''))
        .join('');
      if (text.includes('[reject-start]')) {
        error(request.id, '模拟首条消息被拒绝');
        break;
      }
      if (text.includes('[delay-start]') && !delayedStarts.has(request)) {
        delayedStarts.add(request);
        setTimeout(() => receive(request), 1200);
        break;
      }
      if (options.crashAfterDispatch) {
        process.exit(17);
      }
      if (options.malformed) {
        process.stdout.write('{invalid json\n');
        break;
      }
      if (options.hugeLineBytes) {
        process.stdout.write('x'.repeat(options.hugeLineBytes));
        break;
      }
      if (request.params.model) thread.model = request.params.model;
      if (request.params.serviceTier !== undefined)
        serviceTiers.set(thread.id, request.params.serviceTier);
      if (request.params.effort) thread.reasoningEffort = request.params.effort;
      const current = policy(thread);
      const permissions = (request.params as PermissionSelection).permissions;
      if (options.rejectPermissions && permissions) {
        error(request.id, 'Managed policy rejected permission selection');
        break;
      }
      if (permissions)
        applySettings(thread, { permissions, approvalsReviewer: request.params.approvalsReviewer });
      if (request.params.sandboxPolicy) current.sandbox = request.params.sandboxPolicy;
      if (request.params.approvalPolicy) current.approvalPolicy = request.params.approvalPolicy;
      if (request.params.approvalsReviewer)
        current.approvalsReviewer = request.params.approvalsReviewer;
      policies.set(thread.id, current);
      notifySettings(thread);
      const input: ThreadItem = {
        id: randomUUID(),
        type: 'userMessage',
        clientId: null,
        content: request.params.input,
      };
      const turn: Turn = {
        id: randomUUID(),
        rootTurnId: null,
        items: request.params.input.length ? [input] : [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Date.now() / 1000,
        completedAt: null,
        durationMs: null,
      };
      thread.turns.push(turn);
      thread.model = request.params.model ?? thread.model;
      thread.cwd = request.params.cwd ?? thread.cwd;
      thread.status = { type: 'active', activeFlags: [] };
      if (!thread.preview) thread.preview = text;
      notify({ method: 'turn/started', params: { threadId: thread.id, turn } });
      const name = thread.ephemeral ? undefined : options.threadNames?.[thread.turns.length - 1];
      if (name !== undefined) {
        thread.name = name || null;
        notify({
          method: 'thread/name/updated',
          params: { threadId: thread.id, threadName: name || undefined },
        });
      }
      const acceptedInput = () =>
        request.params.input.length &&
        notify({
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item: input, completedAtMs: Date.now() },
        });
      if (options.userMessageDelayMs && !thread.ephemeral)
        setTimeout(acceptedInput, options.userMessageDelayMs);
      else acceptedInput();
      const receipt = structuredClone(turn);
      setTimeout(
        () =>
          reply(request.id, {
            turn: options.malformedTurnReceipt
              ? { id: receipt.id, status: 'newUnknownStatus', items: [] }
              : receipt,
          }),
        options.ackDelayMs ?? 0,
      );
      const inheritedPrompt = thread.turns
        .flatMap((t) => t.items)
        .filter((item) => item.type === 'userMessage')
        .flatMap((item) => item.content)
        .flatMap((input) => (input.type === 'text' ? input.text : []))
        .join(' ');
      const prompt = (text || inheritedPrompt).toLowerCase();
      if (thread.ephemeral) {
        const titleOutput = options.titleOutputs?.[titleAttempts++] ?? options.titleOutput;
        if (options.titleBehavior === 'hang') break;
        if (options.titleBehavior === 'interaction') {
          approval(thread, turn, 'command');
          break;
        }
        if (options.titleBehavior === 'rename') {
          const original = [...threads.values()].find((entry) => !entry.ephemeral);
          if (original) {
            original.name = '用户手动命名';
            notify({
              method: 'thread/name/updated',
              params: { threadId: original.id, threadName: original.name },
            });
          }
        }
        finishes.set(
          turn.id,
          setTimeout(
            () => {
              const item: ThreadItem = {
                id: randomUUID(),
                type: 'agentMessage',
                phase: 'final_answer',
                memoryCitation: null,
                delivery: null,
                questions: null,
                text: titleOutput ?? JSON.stringify({ title: 'Codex 配置继承与运行设置' }),
              };
              notify({
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
              });
              // Real turn/completed notifications may omit items; the completed item carries the answer.
              complete(
                thread,
                turn,
                options.titleBehavior === 'fail' || prompt.includes('[title-fail]')
                  ? 'failed'
                  : 'completed',
              );
            },
            prompt.includes('[title-fail]') ? 10 : (options.titleDelayMs ?? 50),
          ),
        );
        break;
      }
      const interactive = [
        'questions-choice',
        'permissions',
        'unsupported',
        'elicitation-form',
        'elicitation-choice',
        'elicitation-confirm',
        'elicitation-approval',
        'elicitation-session',
        'elicitation-session-array',
        'elicitation-url',
        'elicitation-openai',
        'elicitation-openai-form',
        'elicitation-malformed',
      ] as const;
      const kind =
        options.approval ??
        interactive.find((candidate) => prompt.includes(`[${candidate}]`)) ??
        (prompt.includes('[questions]')
          ? 'questions'
          : prompt.includes('[file-approval]')
            ? 'file'
            : prompt.includes('[network]')
              ? 'network'
              : prompt.includes('[approval]')
                ? 'command'
                : undefined);
      const reviewStatus =
        options.autoReview ??
        (prompt.includes('[auto-review-denied]')
          ? 'denied'
          : prompt.includes('[auto-review-approved]')
            ? 'approved'
            : prompt.includes('[auto-review-timeout]')
              ? 'timedOut'
              : prompt.includes('[auto-review-aborted]')
                ? 'aborted'
                : prompt.includes('[auto-review-unknown]')
                  ? 'unfinished'
                  : undefined);
      const reconnect = (['recover', 'fail', 'hold'] as const).find((outcome) =>
        prompt.includes(`[codex-retry-${outcome}]`),
      );
      const capacity = /\[capacity-(recover|fail|partial|quote|other)\]/.exec(prompt)?.[1];
      if (capacity) capacityScenario(thread, turn, capacity);
      else if (prompt.includes('[sticky-prompt]') || prompt.includes('[sticky-prompt-stream]'))
        stickyPromptReply(thread, turn, prompt.includes('[sticky-prompt-stream]'));
      else if (
        prompt.includes('[activity-collapse]') ||
        prompt.includes('[activity-stream]') ||
        prompt.includes('[activity-mixed]')
      )
        activityScenario(
          thread,
          turn,
          prompt.includes('[activity-stream]'),
          prompt.includes('[activity-mixed]'),
        );
      else if (prompt.includes('[activity-retry]'))
        activityRetryScenario(thread, turn, prompt.includes('[turn-failure]'));
      else if (prompt.includes('[context-compact-'))
        contextCompaction(
          thread,
          turn,
          prompt.includes('[context-compact-fail]')
            ? 'fail'
            : prompt.includes('[context-compact-hold]')
              ? 'hold'
              : 'recover',
        );
      else if (prompt.includes('[codex-capacity-native]'))
        codexReconnect(thread, turn, 'hold', true);
      else if (reconnect) codexReconnect(thread, turn, reconnect);
      else if (prompt.includes('[async-questions'))
        asyncQuestions(thread, turn, prompt.includes('-running]'), prompt.includes('-multiple]'));
      else if (prompt.includes('[codex-thinking]')) thinking(thread, turn);
      else if (prompt.includes('[mode-approval]') && policy(thread).approvalPolicy !== 'never') {
        if (policy(thread).approvalsReviewer === 'auto_review')
          autoReview(thread, turn, 'approved', prompt);
        else approval(thread, turn, 'command');
      } else if (reviewStatus) autoReview(thread, turn, reviewStatus, prompt);
      else if (kind) approval(thread, turn, kind);
      else if (prompt.includes('[remote-images]') || prompt.includes('[remote-image-errors]'))
        imageReply(thread, turn, prompt.includes('[remote-images]') ? 'remote' : 'remote-errors');
      else if (
        prompt.includes('[local-images]') ||
        prompt.includes('[local-image-errors]') ||
        prompt.includes('[local-temp-images]')
      )
        imageReply(
          thread,
          turn,
          prompt.includes('[local-temp-images]')
            ? 'temporary'
            : prompt.includes('[local-image-errors]')
              ? 'errors'
              : 'normal',
        );
      else if (prompt.includes('[json-files]')) markdownReply(thread, turn, 'json');
      else if (prompt.includes('[diff-preview')) diffPreviewScenario(thread, turn, prompt);
      else if (prompt.includes('[text-files]')) markdownReply(thread, turn, 'text');
      else if (prompt.includes('[markdown-files]')) markdownReply(thread, turn, 'files');
      else if (
        prompt.includes('[command-output-copy]') ||
        prompt.includes('[command-output-truncated]')
      )
        commandOutputScenario(thread, turn, prompt.includes('[command-output-truncated]'));
      else if (prompt.includes('[code-copy]')) markdownReply(thread, turn, 'code');
      else if (prompt.includes('[mermaid]')) markdownReply(thread, turn, 'mermaid');
      else if (prompt.includes('[markdown]') || prompt.includes('[markdown-security]'))
        markdownReply(thread, turn, prompt.includes('[markdown-security]') ? 'security' : 'table');
      else execute(thread, turn);
      break;
    }
    case 'turn/steer': {
      const thread = threads.get(request.params.threadId);
      const turn = thread?.turns.find((entry) => entry.id === request.params.expectedTurnId);
      if (!turn || turn.status !== 'inProgress') {
        error(request.id, 'Turn no longer active');
        break;
      }
      const item: ThreadItem = {
        id: randomUUID(),
        type: 'userMessage',
        clientId: null,
        content: request.params.input,
      };
      turn.items.push(item);
      notify({
        method: 'item/completed',
        params: { threadId: thread!.id, turnId: turn.id, item, completedAtMs: Date.now() },
      });
      reply(request.id, { turnId: turn.id });
      if (turn.items.some((entry) => entry.type === 'agentMessage' && entry.delivery === 'async')) {
        clearTimeout(finishes.get(turn.id));
        execute(thread!, turn);
      }
      break;
    }
    case 'turn/interrupt': {
      const thread = threads.get(request.params.threadId);
      const turn = thread?.turns.find((entry) => entry.id === request.params.turnId);
      if (thread && turn) {
        const lateCancellation = turn.items.some(
          (item) =>
            item.type === 'userMessage' &&
            item.content.some(
              (input) => input.type === 'text' && input.text.includes('[interrupt-ack-first]'),
            ),
        );
        const completionDelay = options.interruptCompletionDelayMs ?? (lateCancellation ? 200 : 0);
        // Cancellation dispatch may be acknowledged before nested tools finish.
        if (completionDelay) {
          clearTimeout(finishes.get(turn.id));
          finishes.set(
            turn.id,
            setTimeout(() => complete(thread, turn, 'interrupted'), completionDelay),
          );
        } else complete(thread, turn, 'interrupted');
        if (lateCancellation)
          setTimeout(() => {
            notify({ method: 'turn/completed', params: { threadId: thread.id, turn } });
            notify({
              method: 'item/commandExecution/outputDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId: 'cancelled-nested-tool',
                delta: '旧工具取消完成',
              },
            });
          }, 1500);
      }
      reply(request.id, {});
      break;
    }
    default:
      error(request.id, 'Method not found', -32601);
  }
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (options.logPath) appendFileSync(options.logPath, line + '\n');
  const message = JSON.parse(line) as
    | ClientRequest
    | { method: 'initialized' }
    | { id: RequestId; result?: unknown; error?: unknown };
  if ('method' in message && message.method === 'initialized') {
    handshaken = true;
    return;
  }
  if (!('method' in message)) {
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    callback?.(message);
    return;
  }
  receive(message);
});
function saveHistory() {
  if (options.historyPath)
    writeFileSync(
      options.historyPath,
      JSON.stringify({
        threads: [...threads.values()].filter((thread) => !thread.ephemeral),
        archived: [...archived],
      }),
    );
}
process.once('SIGTERM', () => {
  stopShells();
  saveHistory();
  process.exit(0);
});
input.on('close', () => {
  stopShells();
  for (const timer of finishes.values()) clearTimeout(timer);
  saveHistory();
  void writes.then(() => process.exit(0));
});

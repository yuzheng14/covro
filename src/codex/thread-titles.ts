import type { ClientRequest } from './generated/ClientRequest.js';
import type { ServerNotification } from './generated/ServerNotification.js';
import type { ConfigReadResponse } from './generated/v2/ConfigReadResponse.js';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse.js';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.js';
import type { Turn } from './generated/v2/Turn.js';
import type { JsonValue } from './generated/serde_json/JsonValue.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import {
  parseTitle,
  selectTitleModel,
  titlePrompt,
  titleOutputSchema,
  TITLE_MODEL,
  TITLE_RESPONSE_MAX_BYTES,
} from './thread-title-policy.js';
import { CodexError, isRecord, type RpcNotification, type RpcTransport } from './transport.js';

// These experimental fields are omitted by the stable protocol generator.
// Their shapes match the verified CLI 0.164.0 app-server protocol.
type TitleSource = ThreadStartResponse & {
  activePermissionProfile?: { id: string } | null;
};
type TemporaryThreadParams = ThreadStartParams & {
  permissions?: string;
  runtimeWorkspaceRoots: [];
  environments: [];
  dynamicTools: [];
  selectedCapabilityRoots: [];
};
type Job = {
  cancelled: boolean;
  threadId?: string;
  turnId?: string;
  terminal: boolean;
  output?: string;
  timer?: NodeJS.Timeout;
  finish: (turn: Turn | null) => void;
};
type Responses = {
  'config/read': ConfigReadResponse;
  'thread/read': ThreadReadResponse;
  'thread/start': TitleSource;
  'turn/start': TurnStartResponse;
  'thread/name/set': unknown;
  'thread/unsubscribe': unknown;
  'turn/interrupt': unknown;
};

/** Optional naming work, scoped to one transport lifetime and never exposed as a user task. */
export class ThreadTitles {
  private readonly candidates = new Map<string, TitleSource>();
  private readonly jobs = new Map<string, Job>();
  private readonly internal = new Map<string, Job | undefined>();
  private readonly manualNames = new Set<string>();
  private readonly nameWrites = new Map<string, Promise<unknown>>();
  private closed = false;
  private hasChatgptAccount = false;
  private models: string[] = [];

  constructor(
    private readonly rpc: RpcTransport,
    private readonly timeoutMs = 30_000,
  ) {
    rpc.once('failure', () => {
      this.closed = true;
      this.candidates.clear();
      for (const job of this.jobs.values()) this.cancel(job);
      this.internal.clear();
    });
  }

  configure(hasChatgptAccount: boolean, models: string[]): void {
    this.hasChatgptAccount = hasChatgptAccount;
    this.models = models;
  }

  register(result: TitleSource): void {
    if (
      !this.closed &&
      !this.manualNames.has(result.thread.id) &&
      !result.thread.name &&
      !result.thread.ephemeral
    )
      this.candidates.set(result.thread.id, { ...result, thread: { ...result.thread, turns: [] } });
    else this.candidates.delete(result.thread.id);
  }

  async prepareManualName(id: string): Promise<void> {
    this.manualNames.add(id);
    this.candidates.delete(id);
    const job = this.jobs.get(id);
    if (job) this.cancel(job);
    // A timeout does not cancel the upstream write. Retain that failure until a new
    // transport lifetime, rather than let a late generated title overwrite a manual name.
    await this.nameWrites.get(id);
  }

  private start(id: string, text: string): void {
    const candidate = this.candidates.get(id);
    // Retry only on a later user-message event, never while another attempt is pending.
    if (!candidate || this.closed || !text.trim() || this.jobs.has(id) || this.nameWrites.has(id))
      return;
    let finish!: Job['finish'];
    const completed = new Promise<Turn | null>((resolve) => {
      finish = resolve;
    });
    const job: Job = { cancelled: false, terminal: false, finish };
    this.jobs.set(id, job);
    this.armTimeout(job);
    void this.generate(id, text, candidate, job, completed)
      .catch(() => {
        /* Keep the upstream preview; naming must never fail the user's task. */
      })
      .finally(() => {
        clearTimeout(job.timer);
        this.jobs.delete(id);
      });
  }

  /** Called before ordinary event mapping, including notifications preceding RPC receipts. */
  notification(message: RpcNotification): boolean {
    const event = message as ServerNotification;
    if (event.method === 'thread/started' && event.params.thread.ephemeral) {
      // The notification can arrive before OR after thread/start's response.
      if (!this.internal.has(event.params.thread.id))
        this.internal.set(event.params.thread.id, undefined);
      return true;
    }
    const params = message.params;
    if (!isRecord(params) || typeof params.threadId !== 'string') return false;
    const id = params.threadId;
    if (this.internal.has(id)) {
      const job = this.internal.get(id);
      if (job && event.method === 'item/completed' && event.params.item.type === 'agentMessage') {
        if (Buffer.byteLength(event.params.item.text) > TITLE_RESPONSE_MAX_BYTES) this.cancel(job);
        else job.output = event.params.item.text;
      }
      if (job && (event.method === 'turn/started' || event.method === 'turn/completed')) {
        job.turnId = event.params.turn.id;
        if (event.method === 'turn/completed') {
          job.terminal = true;
          job.finish(event.params.turn);
        }
      }
      if (job && event.method === 'error' && !event.params.willRetry) this.cancel(job);
      if (event.method === 'thread/closed') this.internal.delete(id);
      return true;
    }
    if (event.method === 'thread/name/updated') {
      const source = this.candidates.get(id);
      if (source) source.thread.name = event.params.threadName ?? null;
      if (event.params.threadName) this.candidates.delete(id);
      const job = this.jobs.get(id);
      if (job) this.cancel(job);
    }
    if (event.method === 'thread/closed') this.candidates.delete(id);
    if (event.method === 'item/completed' && event.params.item.type === 'userMessage') {
      const text = event.params.item.content
        .flatMap((input) => {
          if (input.type !== 'text') return [];
          // CLI removes its IDE context wrapper before constructing the title prompt.
          return input.text.split('## My request for Codex:').at(-1)!.trim();
        })
        .join(' ');
      this.start(id, text);
    }
    return false;
  }

  isInternal(threadId: unknown): boolean {
    return typeof threadId === 'string' && this.internal.has(threadId);
  }

  private cancel(job: Job): void {
    job.cancelled = true;
    job.finish(null);
  }

  private armTimeout(job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(job), this.timeoutMs);
    job.timer.unref();
  }

  private call<M extends keyof Responses>(
    method: M,
    params: Extract<ClientRequest, { method: M }>['params'],
  ): Promise<Responses[M]> {
    return this.rpc.request<Responses[M]>(method, params);
  }

  private async startTemporary(
    source: { cwd: string; modelProvider: string },
    model: string,
    threadSource: string,
    permissions?: string,
  ) {
    // Config reads may redact values to empty strings. Override only enabled flags,
    // never round-trip the returned server definitions (timeouts/credentials/etc.).
    // The filesystem sandbox does not constrain MCP tools.
    const { config } = await this.call('config/read', {
      cwd: source.cwd,
      includeLayers: false,
    });
    const overrides: Record<string, JsonValue> = {
      web_search: 'disabled',
      'cloud.skills.enabled': false,
      'skills.include_instructions': false,
      'tools.experimental_request_user_input.enabled': false,
      'tools.update_plan.enabled': false,
      mcp_servers: Object.fromEntries(
        Object.keys(isRecord(config.mcp_servers) ? config.mcp_servers : {}).map((name) => [
          name,
          { enabled: false },
        ]),
      ) as JsonValue,
    };
    for (const feature of [
      'shell_tool',
      'shell_snapshot',
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'goals',
      'memories',
      'browser_use',
      'browser_use_external',
      'computer_use',
      'image_generation',
      'code_mode',
      'code_mode_only',
      'context_management',
      'current_time_reminder',
      'deferred_executor',
      'enable_fanout',
      'multi_agent_v2',
      'request_permissions_tool',
      'standalone_web_search',
      'token_budget',
      'tool_suggest',
      'unified_exec',
      'view_image',
    ])
      overrides[`features.${feature}`] = false;
    if (!permissions) overrides.default_permissions = ':read-only';
    const params: TemporaryThreadParams = {
      cwd: source.cwd,
      model,
      modelProvider: source.modelProvider,
      ephemeral: true,
      threadSource,
      ...(permissions ? { permissions } : { sandbox: 'read-only' }),
      runtimeWorkspaceRoots: [],
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: overrides,
    };
    return this.call('thread/start', params);
  }

  /** Explicit user-requested recap. Separate inference; no writes to the source thread. */
  async recap(id: string, prompt: string): Promise<string> {
    const key = `recap:${id}`;
    if (this.closed || this.jobs.has(key))
      throw new CodexError('RECAP_BUSY', 'Recap is already running');
    let finish!: Job['finish'];
    const completed = new Promise<Turn | null>((resolve) => {
      finish = resolve;
    });
    const job: Job = { cancelled: false, terminal: false, finish };
    this.jobs.set(key, job);
    this.armTimeout(job);
    try {
      const source = await this.call('thread/read', { threadId: id, includeTurns: false });
      if (job.cancelled || source.thread.id !== id)
        throw new CodexError('RECAP_FAILED', 'Recap was interrupted');
      const generated = await this.startTemporary(
        source.thread,
        source.thread.model ?? '',
        'recap',
      );
      job.threadId = generated.thread.id;
      this.internal.set(job.threadId, job);
      if (job.cancelled || generated.sandbox.type !== 'readOnly')
        throw new CodexError('RECAP_FAILED', 'Recap isolation could not be confirmed');
      const { turn } = await this.call('turn/start', {
        threadId: job.threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
      });
      job.turnId = turn.id;
      if (turn.status !== 'inProgress') {
        job.terminal = true;
        job.finish(turn);
      }
      const result = await completed;
      if (job.cancelled || result?.status !== 'completed')
        throw new CodexError('RECAP_FAILED', 'Recap did not complete');
      const output =
        result.items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? job.output;
      let value: unknown;
      try {
        value = JSON.parse(output ?? '');
      } catch {
        throw new CodexError('RECAP_FAILED', 'Recap returned an invalid response');
      }
      if (
        !isRecord(value) ||
        typeof value.summary !== 'string' ||
        !value.summary.trim() ||
        Buffer.byteLength(value.summary) > TITLE_RESPONSE_MAX_BYTES
      )
        throw new CodexError('RECAP_FAILED', 'Recap returned an invalid response');
      return value.summary.trim();
    } finally {
      clearTimeout(job.timer);
      this.jobs.delete(key);
      if (job.threadId && !this.closed) {
        if (job.turnId && !job.terminal)
          await this.call('turn/interrupt', { threadId: job.threadId, turnId: job.turnId }).catch(
            () => {},
          );
        await this.call('thread/unsubscribe', { threadId: job.threadId }).catch(() => {});
        this.internal.set(job.threadId, undefined);
      }
    }
  }

  private async generate(
    id: string,
    text: string,
    source: TitleSource,
    job: Job,
    completed: Promise<Turn | null>,
  ): Promise<void> {
    try {
      const before = await this.call('thread/read', { threadId: id, includeTurns: false });
      if (job.cancelled || before.thread.id !== id) return;
      if (before.thread.name) {
        this.candidates.delete(id);
        return;
      }
      const model = selectTitleModel(
        before.thread.model ?? source.model,
        before.thread.modelProvider,
        this.hasChatgptAccount,
        this.models,
      );
      const profile = source.activePermissionProfile?.id;
      const permissions = profile && !profile.startsWith(':') ? profile : undefined;
      const generated = await this.startTemporary(
        before.thread,
        model,
        'thread_title',
        permissions,
      );
      job.threadId = generated.thread.id;
      this.internal.set(job.threadId, job);
      if (job.cancelled) return;
      if (
        permissions
          ? generated.activePermissionProfile?.id !== permissions
          : generated.sandbox.type !== 'readOnly'
      )
        return;
      this.armTimeout(job);
      const { turn } = await this.call('turn/start', {
        threadId: job.threadId,
        input: [
          {
            type: 'text',
            text: titlePrompt(text),
            text_elements: [],
          },
        ],
        ...(model === TITLE_MODEL ? { effort: 'low' } : {}),
        outputSchema: titleOutputSchema,
      });
      job.turnId = turn.id;
      if (turn.status !== 'inProgress') {
        job.terminal = true;
        job.finish(turn);
      }
      const result = await completed;
      clearTimeout(job.timer);
      if (job.cancelled || result?.status !== 'completed') return;
      const output =
        result.items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? job.output;
      const title = output ? parseTitle(output) : undefined;
      if (!title) return;
      // An explicit name always wins, including one set while inference was running.
      const latest = await this.call('thread/read', { threadId: id, includeTurns: false });
      if (job.cancelled || latest.thread.id !== id || latest.thread.name) return;
      const write = this.call('thread/name/set', { threadId: id, name: title });
      this.nameWrites.set(id, write);
      void write.then(
        () => this.nameWrites.delete(id),
        (error: unknown) => {
          if (error instanceof CodexError && !error.uncertain) this.nameWrites.delete(id);
        },
      );
      await write;
      this.candidates.delete(id);
    } finally {
      if (job.threadId && !this.closed) {
        if (job.turnId && !job.terminal)
          await this.call('turn/interrupt', { threadId: job.threadId, turnId: job.turnId }).catch(
            () => {},
          );
        await this.call('thread/unsubscribe', { threadId: job.threadId }).catch(() => {});
        // Retain the ID until thread/closed so late notifications cannot leak into the UI.
        if (this.internal.has(job.threadId)) this.internal.set(job.threadId, undefined);
      }
    }
  }
}

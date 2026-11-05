import { randomUUID } from 'node:crypto';
import { nullLogger, type Logger } from '../logging/logger.js';
import { errorFields } from '../logging/fields.js';
import { logContext, withLogContext } from '../logging/context.js';
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
  logger?: Logger;
  stage?: string;
  reason?: string;
  detail?: string;
  outcome?: string;
  started?: number;
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
  private readonly inputContexts = new Map<string, ReturnType<typeof logContext>>();
  private readonly manualNames = new Set<string>();
  private readonly nameWrites = new Map<string, Promise<unknown>>();
  private closed = false;
  private hasChatgptAccount = false;
  private models: string[] = [];

  constructor(
    private readonly rpc: RpcTransport,
    private readonly timeoutMs = 30_000,
    private readonly logger: Logger = nullLogger,
  ) {
    rpc.once('failure', () => {
      this.closed = true;
      this.candidates.clear();
      this.inputContexts.clear();
      for (const job of this.jobs.values()) this.cancel(job, 'TRANSPORT_CLOSED');
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
    else {
      this.candidates.delete(result.thread.id);
      this.inputContexts.delete(result.thread.id);
    }
  }

  trackUserInput(id: string): void {
    if (this.candidates.has(id)) this.inputContexts.set(id, { ...logContext() });
  }

  async prepareManualName(id: string): Promise<void> {
    this.manualNames.add(id);
    this.inputContexts.delete(id);
    this.candidates.delete(id);
    const job = this.jobs.get(id);
    if (job) this.cancel(job, 'MANUAL_NAME');
    // A timeout does not cancel the upstream write. Retain that failure until a new
    // transport lifetime, rather than let a late generated title overwrite a manual name.
    await this.nameWrites.get(id);
  }

  private start(id: string, text: string): void {
    const candidate = this.candidates.get(id);
    // Retry only on a later user-message event, never while another attempt is pending.
    const reason = !candidate
      ? 'not_candidate'
      : this.closed
        ? 'transport_closed'
        : !text.trim()
          ? 'empty_message'
          : this.jobs.has(id)
            ? 'already_running'
            : this.nameWrites.has(id)
              ? 'name_write_pending'
              : undefined;
    if (reason) {
      this.logger.debug('thread_title.skipped', { threadId: id, reason });
      return;
    }
    let finish!: Job['finish'];
    const completed = new Promise<Turn | null>((resolve) => {
      finish = resolve;
    });
    const jobId = randomUUID();
    const context = this.inputContexts.get(id) ?? logContext();
    const logger = this.logger.child({ ...context, threadId: id, jobId });
    const job: Job = {
      cancelled: false,
      terminal: false,
      finish,
      logger,
      stage: 'source_read',
      started: performance.now(),
    };
    logger.info('thread_title.started');
    this.jobs.set(id, job);
    this.armTimeout(job);
    void withLogContext({ ...context, threadId: id, sourceThreadId: id, jobId }, () =>
      this.generate(id, text, candidate!, job, completed),
    )
      .catch((error: unknown) => {
        job.reason ??= 'TITLE_RPC_FAILED';
        logger.warn('thread_title.error', { stage: job.stage, ...errorFields(error) });
      })
      .finally(() => {
        clearTimeout(job.timer);
        this.jobs.delete(id);
        const outcome =
          job.outcome ??
          (['MANUAL_NAME', 'NAME_UPDATED', 'CANCELLED', 'TRANSPORT_CLOSED'].includes(
            job.reason ?? '',
          )
            ? 'cancelled'
            : job.reason
              ? 'failed'
              : 'skipped');
        logger[outcome === 'failed' ? 'warn' : 'info']('thread_title.finished', {
          stage: job.stage,
          outcome,
          errorCode: job.reason,
          reason: job.detail,
          durationMs: Math.round(performance.now() - job.started!),
          temporaryThreadId: job.threadId,
        });
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
        if (Buffer.byteLength(event.params.item.text) > TITLE_RESPONSE_MAX_BYTES)
          this.cancel(job, 'TITLE_OUTPUT_TOO_LARGE');
        else job.output = event.params.item.text;
      }
      if (job && (event.method === 'turn/started' || event.method === 'turn/completed')) {
        job.turnId = event.params.turn.id;
        if (event.method === 'turn/completed') {
          job.terminal = true;
          job.finish(event.params.turn);
        }
      }
      if (job && event.method === 'error') {
        const info = event.params.error.codexErrorInfo;
        const errorCode =
          typeof info === 'string' ? info : info ? Object.keys(info)[0] : 'UPSTREAM_ERROR';
        job.logger?.warn('thread_title.upstream_failed', {
          temporaryThreadId: id,
          stage: job.stage,
          errorCode,
          willRetry: event.params.willRetry,
        });
        if (!event.params.willRetry) this.cancel(job, 'UPSTREAM_ERROR');
      }
      if (event.method === 'thread/closed') this.internal.delete(id);
      return true;
    }
    if (event.method === 'thread/name/updated') {
      const source = this.candidates.get(id);
      if (source) source.thread.name = event.params.threadName ?? null;
      if (event.params.threadName) {
        this.candidates.delete(id);
        this.inputContexts.delete(id);
      }
      const job = this.jobs.get(id);
      if (job) this.cancel(job, 'NAME_UPDATED');
    }
    if (event.method === 'thread/closed') {
      this.candidates.delete(id);
      this.inputContexts.delete(id);
    }
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

  private cancel(job: Job, reason = 'CANCELLED'): void {
    job.reason ??= reason;
    job.cancelled = true;
    job.finish(null);
  }

  private armTimeout(job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(job, 'TITLE_TIMEOUT'), this.timeoutMs);
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
    job?: Job,
  ) {
    if (job) job.stage = 'config_read';
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
    if (job) job.stage = 'temporary_thread_start';
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
    const logger = this.logger.child({ ...logContext(), threadId: id, jobId: randomUUID() });
    const started = performance.now();
    logger.info('recap.started');
    let succeeded = false;
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
      succeeded = true;
      return value.summary.trim();
    } catch (error) {
      logger.warn('recap.failed', errorFields(error));
      throw error;
    } finally {
      logger.info('recap.finished', {
        outcome: succeeded ? 'succeeded' : 'failed',
        reason: job.reason,
        durationMs: Math.round(performance.now() - started),
      });
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
      if (job.cancelled || before.thread.id !== id) {
        job.reason ??= 'SOURCE_MISMATCH';
        return;
      }
      if (before.thread.name) {
        job.outcome = 'skipped';
        job.reason = 'NAME_EXISTS';
        this.candidates.delete(id);
        return;
      }
      const model = selectTitleModel(
        before.thread.model ?? source.model,
        before.thread.modelProvider,
        this.hasChatgptAccount,
        this.models,
      );
      job.logger?.info('thread_title.model_selected', {
        model,
        provider: before.thread.modelProvider,
      });
      const profile = source.activePermissionProfile?.id;
      const permissions = profile && !profile.startsWith(':') ? profile : undefined;
      const generated = await this.startTemporary(
        before.thread,
        model,
        'thread_title',
        permissions,
        job,
      );
      job.threadId = generated.thread.id;
      job.logger?.debug('thread_title.temporary_created', { temporaryThreadId: job.threadId });
      this.internal.set(job.threadId, job);
      if (job.cancelled) return;
      if (
        permissions
          ? generated.activePermissionProfile?.id !== permissions
          : generated.sandbox.type !== 'readOnly'
      ) {
        job.reason = 'ISOLATION_MISMATCH';
        return;
      }
      this.armTimeout(job);
      job.stage = 'turn_start';
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
      job.stage = 'generation';
      const result = await completed;
      clearTimeout(job.timer);
      if (job.cancelled || result?.status !== 'completed') {
        job.reason ??= 'TITLE_TURN_FAILED';
        return;
      }
      job.stage = 'output_validation';
      const output =
        result.items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? job.output;
      const title = output ? parseTitle(output) : undefined;
      if (!title) {
        job.reason = 'INVALID_TITLE_OUTPUT';
        job.detail = 'invalid_schema';
        if (!output) job.detail = 'missing_output';
        else
          try {
            const value: unknown = JSON.parse(output);
            if (isRecord(value) && typeof value.title === 'string' && !value.title.trim())
              job.detail = 'empty_title';
          } catch {
            job.detail = 'invalid_json';
          }
        return;
      }
      job.logger?.debug('thread_title.output_validated', {
        outputBytes: Buffer.byteLength(output!),
      });
      job.stage = 'name_read';
      // An explicit name always wins, including one set while inference was running.
      const latest = await this.call('thread/read', { threadId: id, includeTurns: false });
      if (job.cancelled || latest.thread.id !== id || latest.thread.name) {
        job.reason ??= latest.thread.name ? 'NAME_EXISTS' : 'SOURCE_MISMATCH';
        job.outcome = 'skipped';
        return;
      }
      job.stage = 'name_write';
      const write = this.call('thread/name/set', { threadId: id, name: title });
      this.nameWrites.set(id, write);
      void write.then(
        () => this.nameWrites.delete(id),
        (error: unknown) => {
          if (error instanceof CodexError && !error.uncertain) this.nameWrites.delete(id);
        },
      );
      await write;
      this.inputContexts.delete(id);
      job.outcome = 'succeeded';
      job.reason = undefined;
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

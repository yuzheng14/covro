import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexClient, CodexDiagnostics, CodexEvent } from '../../src/codex/types.js';
import type {
  ActionResolution,
  Settings,
  ModelDefaults,
  ThreadPage,
  ThreadView,
  TurnView,
} from '../../src/shared/types.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { GatewayService } from '../../src/server/service.js';
import { databaseHarness } from './domain-db-helpers.js';
import type { Logger } from '../../src/logging/logger.js';

export const operationId = () => randomUUID();
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function threadView(id: string, cwd: string): ThreadView {
  return {
    id,
    cwd,
    projectId: '',
    source: 'appServer',
    title: id,
    status: 'idle',
    turns: [],
    actions: [],
    managed: false,
  };
}
export class DomainCodex implements CodexClient {
  epoch = 'epoch-one';
  pid = 123;
  ready = true;
  codexVersion: string | null = 'test';
  verifiedVersion = 'test';
  compatibility: CodexDiagnostics['compatibility'] = 'verified';
  readonly listeners = new Set<(event: CodexEvent) => void>();
  readonly threads = new Map<string, ThreadView>();
  archives = 0;
  unarchives = 0;
  starts = 0;
  reviews = 0;
  creates = 0;
  steers = 0;
  interrupts = 0;
  compactions = 0;
  resumes = 0;
  forks = 0;
  replies = 0;
  stops = 0;
  startGate?: ReturnType<typeof deferred<TurnView>>;
  replyGate?: ReturnType<typeof deferred<void>>;
  onStart?: (threadId: string, turn: TurnView) => void;
  diagnostics(): CodexDiagnostics {
    return {
      ready: this.ready,
      connection: this.ready ? 'ready' : 'unavailable',
      codexVersion: this.codexVersion,
      verifiedVersion: this.verifiedVersion,
      compatibility: this.compatibility,
      codexEpoch: this.epoch,
      authenticated: true,
      models: [],
      capabilities: [],
    };
  }
  async start() {
    this.ready = true;
  }
  async stop() {
    this.stops++;
    this.ready = false;
  }
  onEvent(listener: (event: CodexEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: CodexEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async listThreads(_cwd: string, _cursor?: string, archived = false): Promise<ThreadPage> {
    return {
      data: structuredClone(
        [...this.threads.values()].filter((thread) => Boolean(thread.archived) === archived),
      ),
      nextCursor: null,
    };
  }
  async archiveThread(id: string) {
    this.archives++;
    this.threads.get(id)!.archived = true;
    this.emit({ type: 'threadArchive', threadId: id, archived: true });
  }
  async renameThread(id: string, name: string) {
    this.threads.get(id)!.title = name;
    this.emit({ type: 'threadName', threadId: id, name });
  }
  async unarchiveThread(id: string) {
    this.unarchives++;
    this.threads.get(id)!.archived = false;
    this.emit({ type: 'threadArchive', threadId: id, archived: false });
    return this.readThread(id);
  }
  async readRuntimeSettings(_cwd: string) {
    return { model: 'test-model', reasoningEffort: 'medium' };
  }
  async saveModelDefaults(_settings: ModelDefaults) {
    return { status: 'ok' as const };
  }
  async readThreadMetadata(id: string): Promise<ThreadView> {
    const thread = this.threads.get(id);
    if (!thread) throw new Error('Thread not found');
    return structuredClone({ ...thread, turns: [] });
  }
  async readThread(id: string) {
    const thread = this.threads.get(id);
    if (!thread) throw new Error('Thread not found');
    return structuredClone(thread);
  }
  async createThread(cwd: string, _settings?: Settings) {
    this.creates++;
    const thread = threadView(`thread-${this.threads.size + 1}`, cwd);
    thread.hasMessages = false;
    this.threads.set(thread.id, thread);
    this.emit({ type: 'thread', thread });
    return structuredClone(thread);
  }
  async resumeThread(id: string, _cwd: string, _settings?: Settings) {
    this.resumes++;
    return this.readThread(id);
  }
  async forkThread(id: string, cwd: string, _settings?: Settings) {
    this.forks++;
    const source = await this.readThread(id);
    const fork: ThreadView = {
      ...source,
      id: `fork-${this.forks}`,
      cwd,
      forkedFromId: id,
      source: 'appServer',
      managed: false,
      status: 'idle',
      actions: [],
      turns: source.turns.map((turn) => ({
        ...turn,
        threadId: `fork-${this.forks}`,
        status: ['running', 'waitingApproval', 'waitingInput'].includes(turn.status)
          ? 'interrupted'
          : turn.status,
      })),
    };
    this.threads.set(fork.id, fork);
    this.emit({ type: 'thread', thread: structuredClone(fork) });
    return structuredClone(fork);
  }
  async startTurn(
    id: string,
    _cwd: string,
    text: string,
    _settings?: Settings,
    images?: string[],
    _skills?: import('../../src/shared/skills.js').SkillReference[],
    clientId?: string,
  ) {
    this.starts++;
    const turn: TurnView = {
      id: `turn-${this.starts}`,
      threadId: id,
      status: 'running',
      items: [
        {
          id: `user-${this.starts}`,
          type: 'userMessage',
          text,
          ...(clientId ? { clientId } : {}),
          ...(images?.length ? { images, imageCount: images.length } : {}),
        },
      ],
    };
    const thread = this.threads.get(id)!;
    thread.status = 'running';
    thread.hasMessages = true;
    thread.turns.push(turn);
    this.emit({ type: 'turn', threadId: id, turn });
    this.onStart?.(id, turn);
    return this.startGate ? this.startGate.promise : structuredClone(turn);
  }
  async startReview(id: string) {
    this.reviews++;
    const turn: TurnView = {
      id: `review-${this.reviews}`,
      threadId: id,
      status: 'running',
      items: [{ id: `review-mode-${this.reviews}`, type: 'enteredReviewMode', text: '未提交改动' }],
    };
    const thread = this.threads.get(id)!;
    thread.status = 'running';
    thread.turns.push(turn);
    this.emit({ type: 'turn', threadId: id, turn: structuredClone(turn) });
    this.onStart?.(id, turn);
    return this.startGate ? this.startGate.promise : structuredClone(turn);
  }
  async steerTurn(_id: string, turnId: string, _text: string) {
    this.steers++;
    return { turnId };
  }
  async interruptTurn(_id: string, _turnId: string) {
    this.interrupts++;
  }
  async compactThread(_id: string) {
    this.compactions++;
  }
  async respond(_actionId: string, _resolution: ActionResolution) {
    this.replies++;
    await this.replyGate?.promise;
  }
  complete(id: string, turnId: string) {
    const thread = this.threads.get(id)!;
    const turn = thread.turns.find((entry) => entry.id === turnId)!;
    turn.status = 'completed';
    thread.status = 'completed';
    this.emit({ type: 'turn', threadId: id, turn: structuredClone(turn) });
  }
  reset() {
    this.ready = false;
    this.emit({ type: 'runtime', diagnostics: this.diagnostics() });
    this.epoch = randomUUID();
    this.ready = true;
    this.emit({ type: 'runtime', diagnostics: this.diagnostics() });
  }
}

export function harness(logger?: Logger) {
  const { directory, filename, db, store, close } = databaseHarness(logger);
  const project = join(directory, 'project');
  mkdirSync(project);
  const codex = new DomainCodex();
  const projects = new ProjectRegistry([{ id: 'project', name: '测试项目', path: project }]);
  const service = new GatewayService({ store, projects, codex, logger });
  return { directory, project, filename, db, store, codex, projects, service, close };
}

import type {
  ActionResolution,
  AutoReviewView,
  ItemView,
  RuntimeSettings,
  PendingAction,
  RunStatus,
  Settings,
  ModelDefaults,
  ModelDefaultsResult,
  SystemInfo,
  ThreadPage,
  ThreadView,
  TurnView,
  TurnErrorMetadata,
} from '../shared/types.js';

export type CodexDiagnostics = Omit<SystemInfo, 'authMode' | 'demo' | 'compatibilityConfirmation'>;
export type CodexEvent =
  | { type: 'thread'; thread: ThreadView }
  | { type: 'threadSettings'; threadId: string; settings: RuntimeSettings }
  | { type: 'threadName'; threadId: string; name?: string }
  | { type: 'threadArchive'; threadId: string; archived: boolean }
  | { type: 'threadStatus'; threadId: string; status: RunStatus }
  | { type: 'turn'; threadId: string; turn: TurnView }
  | ({
      type: 'turnError';
      threadId: string;
      turnId: string;
      message: string;
      willRetry: boolean;
    } & TurnErrorMetadata)
  | { type: 'compactionCompleted'; threadId: string; turnId: string }
  | { type: 'turnProgress'; threadId: string; turnId: string }
  | { type: 'item'; threadId: string; turnId: string; item: ItemView }
  | { type: 'autoReview'; threadId: string; turnId: string; review: AutoReviewView }
  | {
      type: 'delta';
      threadId: string;
      turnId: string;
      itemId: string;
      field: 'text' | 'output';
      delta: string;
      itemType: string;
    }
  | { type: 'diff'; threadId: string; turnId: string; diff: string }
  | { type: 'action'; action: PendingAction }
  | { type: 'actionResolved'; actionId: string }
  | { type: 'runtime'; diagnostics: CodexDiagnostics };
export interface CodexClient {
  executeCommand?(
    processId: string,
    cwd: string,
    command: string,
    output: (stream: 'stdout' | 'stderr', bytes: Buffer, capReached: boolean) => void,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  terminateCommand?(processId: string): Promise<void>;
  readonly epoch: string;
  readonly pid: number | undefined;
  readonly ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): CodexDiagnostics;
  readRuntimeSettings(cwd: string): Promise<RuntimeSettings>;
  saveModelDefaults(settings: ModelDefaults): Promise<ModelDefaultsResult>;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  listThreads(cwd: string | string[], cursor?: string, archived?: boolean): Promise<ThreadPage>;
  archiveThread(id: string): Promise<void>;
  renameThread(id: string, name: string): Promise<void>;
  unarchiveThread(id: string): Promise<ThreadView>;
  readThread(id: string): Promise<ThreadView>;
  /** One recent-to-old history page, without reading the rest of the conversation. */
  readThreadPage?(id: string, cursor?: string): Promise<ThreadView>;
  readThreadMetadata(id: string): Promise<ThreadView>;
  createThread(cwd: string, settings?: Settings): Promise<ThreadView>;
  forkThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView>;
  resumeThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView>;
  startTurn(
    id: string,
    cwd: string,
    text: string,
    settings?: Settings,
    images?: string[],
  ): Promise<TurnView>;
  /** Native inline review of the current checkout's uncommitted changes. */
  startReview(id: string): Promise<TurnView>;
  steerTurn(
    id: string,
    turnId: string,
    text: string,
    images?: string[],
  ): Promise<{ turnId: string }>;
  interruptTurn(id: string, turnId: string): Promise<void>;
  compactThread(id: string): Promise<void>;
  respond(actionId: string, resolution: ActionResolution): Promise<void>;
}

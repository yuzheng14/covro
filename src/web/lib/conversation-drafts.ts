import type { Operation, Settings } from '../../shared/types';

export interface SentDraft {
  key: string;
  text: string;
  images?: string[];
  skills?: import('../../shared/skills').SkillReference[];
}

export type DraftSubmission =
  | { kind: 'create'; key: string; projectId: string; settings: Settings; creationId?: string }
  | ({ kind: 'send' } & SentDraft);

/** In-memory draft ownership follows creation receipts; prompts never enter operation storage. */
export class ConversationDrafts {
  private keys = new Map<string, string>();
  private submissions = new Map<string, DraftSubmission>();
  snapshotKeys() {
    return Object.fromEntries(this.keys);
  }
  restoreKeys(keys: Record<string, string>) {
    for (const [key, value] of Object.entries(keys))
      if (!this.keys.has(key)) this.keys.set(key, value);
  }

  creationId(key: string) {
    const scope = `creation:${key}`;
    const id = this.keys.get(scope) ?? crypto.randomUUID();
    this.keys.set(scope, id);
    return id;
  }

  key(projectId: string, threadId?: string) {
    const scope = threadId ?? `project:${projectId}`;
    return this.keys.get(scope) ?? scope;
  }

  track(id: string, submission: DraftSubmission) {
    this.submissions.set(id, submission);
  }

  discard(id: string) {
    const submission = this.submissions.get(id);
    if (submission?.kind === 'create') this.keys.delete(`creation:${submission.key}`);
    this.submissions.delete(id);
  }

  apply(operation: Operation) {
    const submission = this.submissions.get(operation.clientOperationId);
    if (!submission) return;
    if (operation.status === 'failed') {
      this.discard(operation.clientOperationId);
    }
    if (operation.status !== 'acknowledged') return;
    this.discard(operation.clientOperationId);
    if (submission.kind === 'send') return { sent: submission };
    const id = (operation.result as { threadId?: string } | undefined)?.threadId;
    if (!id) return;
    this.keys.set(id, submission.key);
    this.keys.set(`project:${submission.projectId}`, `draft:${crypto.randomUUID()}`);
    return { created: { id, settings: submission.settings } };
  }
}

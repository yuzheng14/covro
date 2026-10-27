import { describe, expect, it, vi } from 'vitest';
import {
  createSlashCommands,
  validateSlashCommand,
  type SlashCommandContext,
} from '../../src/web/lib/slash-commands';
import { operationNeedsCompatibilityConfirmation } from '../../src/web/lib/compatibility';

function context(): SlashCommandContext {
  return {
    project: {
      id: 'project',
      name: 'Project',
      rootPath: '/project',
      canonicalRoot: '/project',
      workspaceKey: '/project',
      available: true,
    },
    selectedId: 'thread',
    thread: {
      id: 'thread',
      projectId: 'project',
      cwd: '/project',
      source: 'appServer',
      title: 'Review',
      status: 'idle',
      turns: [],
      managed: true,
      actions: [],
    },
    system: {
      ready: true,
      connection: 'ready',
      codexVersion: '0.162.1',
      verifiedVersion: '0.162.1',
      compatibility: 'verified',
      compatibilityConfirmation: 'not-required',
      codexEpoch: 'epoch',
      authenticated: true,
      authMode: 'local',
      models: [],
      capabilities: ['review/start'],
      demo: true,
    },
    connection: 'connected',
    authRequired: false,
    settings: { model: 'unsent-override' },
    openDraft: vi.fn().mockReturnValue('project-draft'),
    busy: [],
    operations: [],
    run: vi.fn().mockResolvedValue({
      status: 'acknowledged',
      result: { threadId: 'thread', turnId: 'review-turn' },
    }),
    onResumeAttempt: vi.fn(),
    refreshThread: vi.fn().mockResolvedValue(undefined),
    openStatus: vi.fn(),
    exportThread: vi.fn().mockResolvedValue('test.md'),
  };
}
const review = (state: SlashCommandContext) =>
  createSlashCommands(() => state).find((command) => command.name === 'review')!;

describe('/review in the composer', () => {
  it('dispatches only native review without text or unsent settings and labels acceptance accurately', async () => {
    const state = context();
    expect(await review(state).run()).toEqual({
      message: '已提交代码审查，请在当前会话查看进度和结果。',
    });
    expect(state.run).toHaveBeenCalledWith('review', 'thread', '/api/threads/thread/review', {
      target: { type: 'uncommittedChanges' },
    });
    expect(
      validateSlashCommand(
        '/review custom instructions',
        createSlashCommands(() => state),
      ),
    ).toBeUndefined();
  });
  it('guards unmanaged, archived, active, uncertain and unsupported contexts with specific reasons', async () => {
    const cases: [Partial<SlashCommandContext['thread']>, string][] = [
      [{ managed: false }, '尚未恢复'],
      [{ archived: true }, '已归档'],
      [{ status: 'running' }, '仍在运行'],
      [{ status: 'unknown' }, '尚未确认'],
    ];
    for (const [patch, reason] of cases) {
      const state = context();
      Object.assign(state.thread!, patch);
      expect(review(state).unavailableReason).toContain(reason);
      expect(await review(state).run()).toMatchObject({ error: true });
      expect(state.run).not.toHaveBeenCalled();
    }
    const state = context();
    state.system!.capabilities = [];
    expect(review(state).unavailableReason).toContain('review/start');
    state.system!.compatibilityConfirmation = 'required';
    expect(operationNeedsCompatibilityConfirmation('review', state.system)).toBe(true);
  });
  it('retains failure and uncertainty instead of treating a review request as completed', async () => {
    const state = context();
    for (const result of [
      undefined,
      { status: 'unknown' },
      { status: 'failed', error: { message: 'Not a Git repository' } },
    ]) {
      state.run = vi.fn().mockResolvedValue(result);
      expect(await review(state).run()).toMatchObject({ error: true });
    }
  });
});

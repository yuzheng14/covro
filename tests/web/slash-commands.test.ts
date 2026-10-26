import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '../../src/shared/types';
import {
  createSlashCommands,
  filterSlashCommands,
  parseSlashCommand,
  validateSlashCommand,
  type SlashCommandContext,
  type SlashCommandName,
} from '../../src/web/lib/slash-commands';

function receipt(status: Operation['status'] = 'acknowledged'): Operation {
  return {
    clientOperationId: 'operation',
    kind: 'thread.create',
    target: 'project',
    status,
    result: { threadId: 'created-thread' },
    createdAt: 1,
    updatedAt: 2,
  };
}

function context(): SlashCommandContext {
  return {
    project: {
      id: 'project/one',
      name: 'Project',
      rootPath: '/project',
      canonicalRoot: '/project',
      workspaceKey: '/project',
      available: true,
    },
    selectedId: 'thread/one',
    thread: {
      id: 'thread/one',
      projectId: 'project/one',
      cwd: '/project',
      source: 'cli',
      title: 'History',
      status: 'completed',
      turns: [{ id: 'turn', threadId: 'thread/one', status: 'completed', items: [] }],
      managed: false,
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
      capabilities: [
        'thread/start',
        'thread/fork',
        'thread/resume',
        'turn/interrupt',
        'thread/compact/start',
      ],
      demo: true,
    },
    connection: 'connected',
    authRequired: false,
    settings: { model: 'thread-override' },
    openDraft: vi.fn().mockReturnValue('project-draft'),
    busy: [],
    operations: [],
    run: vi.fn().mockResolvedValue(receipt()),
    onResumeAttempt: vi.fn(),
    refreshThread: vi.fn().mockResolvedValue(undefined),
    openStatus: vi.fn(),
    exportThread: vi.fn().mockResolvedValue({ partial: false }),
  };
}

function command(state: SlashCommandContext, name: SlashCommandName) {
  return createSlashCommands(() => state).find((entry) => entry.name === name)!;
}

function activeThread(state: SlashCommandContext) {
  state.thread!.managed = true;
  state.thread!.status = 'running';
  state.thread!.turns[0]!.status = 'running';
}

describe('slash command parsing and validation', () => {
  it('recognizes only a leading single slash, preserving escaped and embedded message text', () => {
    expect(parseSlashCommand(' \n /HELP \t argument\nsecond line ')).toEqual({
      name: 'help',
      arguments: 'argument\nsecond line',
    });
    expect(parseSlashCommand('/')).toEqual({ name: '', arguments: '' });
    expect(parseSlashCommand('/new \n')).toEqual({ name: 'new', arguments: '' });
    for (const input of ['', 'ordinary /help text', '//help', '  ///help', 'https://example.com'])
      expect(parseSlashCommand(input)).toBeNull();
  });

  it('lists commands for a slash and searches names and descriptions', () => {
    const commands = createSlashCommands(context);
    expect(filterSlashCommands(commands, '/')).toHaveLength(11);
    expect(filterSlashCommands(commands, '/st').map((entry) => entry.name)).toEqual([
      'stop',
      'status',
    ]);
    expect(filterSlashCommands(commands, '/历史').map((entry) => entry.name)).toEqual([
      'fork',
      'resume',
    ]);
    expect(filterSlashCommands(commands, '/帮助')).toEqual([]);
    expect(filterSlashCommands(commands, '//help')).toEqual([]);
  });

  it('ranks exact names then prefixes before description matches, preserving catalog order', () => {
    const commands = createSlashCommands(context).map((entry) => ({
      ...entry,
      description: entry.name === 'help' ? 'new 与 status' : entry.description,
    }));
    expect(filterSlashCommands(commands, '/new').map((entry) => entry.name)).toEqual([
      'new',
      'help',
    ]);
    expect(filterSlashCommands(commands, '/sta').map((entry) => entry.name)).toEqual([
      'status',
      'help',
    ]);
  });

  it('keeps arguments attached to their exact command and rejects unsupported arguments', () => {
    const commands = createSlashCommands(context);
    expect(filterSlashCommands(commands, '/new extra').map((entry) => entry.name)).toEqual(['new']);
    expect(filterSlashCommands(commands, '/n extra')).toEqual([]);
    expect(validateSlashCommand('/new extra', commands)).toContain('不接受参数');
    expect(validateSlashCommand('/resume another-thread', commands)).toContain(
      '/resume（无需参数）',
    );
    expect(validateSlashCommand('/missing', commands)).toContain('未知命令 /missing');
    expect(validateSlashCommand('/', commands)).toContain('请选择命令');
    expect(validateSlashCommand('/new   ', commands)).toBeUndefined();
    expect(validateSlashCommand('//missing', commands)).toBeUndefined();
  });
});

describe('slash command availability', () => {
  it('exports the captured thread through a read-only download, including archived or clipped views', async () => {
    const state = context();
    state.system!.capabilities.push('thread/read');
    state.system!.compatibilityConfirmation = 'required';
    state.thread!.archived = true;
    state.thread!.historyTruncated = true;
    expect(command(state, 'export').unavailableReason).toBeUndefined();
    expect(await command(state, 'export').run()).toMatchObject({
      message: expect.stringContaining('Markdown 下载'),
    });
    expect(state.exportThread).toHaveBeenCalledWith('thread/one');
    expect(state.run).not.toHaveBeenCalled();
    expect(
      validateSlashCommand(
        '/export another-thread',
        createSlashCommands(() => state),
      ),
    ).toContain('不接受参数');
  });

  it('reports partial exports and download failures without claiming a complete or saved file', async () => {
    const state = context();
    state.system!.capabilities.push('thread/read');
    vi.mocked(state.exportThread).mockResolvedValueOnce({ partial: true });
    expect(await command(state, 'export').run()).toMatchObject({
      message: expect.stringContaining('未完成'),
    });
    vi.mocked(state.exportThread).mockRejectedValueOnce(new Error('历史读取失败'));
    expect(await command(state, 'export').run()).toEqual({ error: true, message: '历史读取失败' });
    state.thread = undefined;
    expect(command(state, 'export').unavailableReason).toContain('正在加载');
    state.selectedId = undefined;
    expect(command(state, 'export').unavailableReason).toContain('选择一个会话');
  });

  it.each([
    [
      'offline',
      (state: SlashCommandContext) => {
        state.connection = 'disconnected';
      },
      '离线',
    ],
    [
      'expired login',
      (state: SlashCommandContext) => {
        state.authRequired = true;
      },
      '登录已过期',
    ],
    [
      'Codex authentication',
      (state: SlashCommandContext) => {
        state.system!.authenticated = false;
      },
      '认证',
    ],
    [
      'runtime readiness',
      (state: SlashCommandContext) => {
        state.system!.ready = false;
      },
      'Codex 尚不可用',
    ],
    [
      'compatibility',
      (state: SlashCommandContext) => {
        state.system!.compatibilityConfirmation = 'required';
      },
      '兼容性',
    ],
    [
      'project selection',
      (state: SlashCommandContext) => {
        state.project = undefined;
      },
      '选择一个项目',
    ],
    [
      'project availability',
      (state: SlashCommandContext) => {
        state.project!.available = false;
      },
      '项目目录不可用',
    ],
    [
      'busy create',
      (state: SlashCommandContext) => {
        state.busy = ['create:project/one'];
      },
      '正在新建',
    ],
    [
      'unknown create',
      (state: SlashCommandContext) => {
        state.operations = [
          {
            clientOperationId: 'pending',
            kind: 'create',
            target: 'project/one',
            status: 'unknown',
            createdAt: 1,
          },
        ];
      },
      '尚未确认',
    ],
  ])(
    'blocks new for %s while retaining local help and diagnostics',
    async (_label, update, message) => {
      const state = context();
      update(state);
      const commands = createSlashCommands(() => state);
      expect(validateSlashCommand('/new', commands)).toContain(message);
      expect(await command(state, 'new').run()).toMatchObject({
        error: true,
        message: expect.stringContaining(message),
      });
      expect(command(state, 'help').unavailableReason).toBeUndefined();
      expect(command(state, 'status').unavailableReason).toBeUndefined();
      expect(state.run).not.toHaveBeenCalled();
    },
  );

  it('explains missing/loading/empty histories and a missing Fork capability', () => {
    const state = context();
    state.thread = undefined;
    expect(command(state, 'fork').unavailableReason).toContain('加载');
    state.selectedId = undefined;
    expect(command(state, 'fork').unavailableReason).toContain('选择一个会话');
    state.thread = context().thread;
    state.thread!.turns = [];
    expect(command(state, 'fork').unavailableReason).toContain('当前会话为空');
    state.system!.capabilities = ['thread/start'];
    expect(command(state, 'fork').unavailableReason).toContain('thread/fork');
  });

  it('allows Fork while the source is running or occupied, but blocks a duplicate Fork', () => {
    const state = context();
    activeThread(state);
    expect(command(state, 'fork').unavailableReason).toBeUndefined();
    state.thread!.managed = false;
    state.thread!.resumeError = { code: 'THREAD_IN_USE', message: 'occupied' };
    state.operations = [
      {
        clientOperationId: 'pending',
        kind: 'send',
        target: 'thread/one',
        status: 'unknown',
        createdAt: 1,
      },
    ];
    expect(command(state, 'fork').unavailableReason).toBeUndefined();
    state.operations[0]!.kind = 'fork';
    expect(command(state, 'fork').unavailableReason).toContain('Fork 请求尚未确认');
    state.operations = [];
    state.busy = ['fork:thread/one'];
    expect(command(state, 'fork').unavailableReason).toContain('正在 Fork');
  });

  it('retries a previous writer conflict but blocks active, uncertain, or already managed resumes', () => {
    const state = context();
    state.thread!.resumeError = { code: 'THREAD_IN_USE', message: 'occupied' };
    expect(command(state, 'resume').unavailableReason).toBeUndefined();
    state.thread!.status = 'running';
    state.thread!.turns[0]!.status = 'running';
    expect(command(state, 'resume').unavailableReason).toBeUndefined();
    activeThread(state);
    expect(command(state, 'resume').unavailableReason).toContain('仍在运行');
    state.thread = context().thread;
    state.thread!.execution = {
      operationId: 'old',
      threadId: 'thread/one',
      workspaceKey: '/project',
      codexEpoch: 'old',
      ended: false,
    };
    expect(command(state, 'resume').unavailableReason).toContain('执行占用');
    state.thread!.execution = undefined;
    state.thread!.managed = true;
    expect(command(state, 'resume').unavailableReason).toContain('已恢复');
    state.operations = [
      {
        clientOperationId: 'pending',
        kind: 'send',
        target: 'thread/one',
        status: 'unknown',
        createdAt: 1,
      },
    ];
    expect(command(state, 'resume').unavailableReason).toContain('尚未确认');
  });

  it('permits stopping during compatibility confirmation, while respecting ownership and active turns', () => {
    const state = context();
    activeThread(state);
    state.system!.compatibilityConfirmation = 'required';
    expect(command(state, 'stop').unavailableReason).toBeUndefined();
    state.thread!.managed = false;
    state.thread!.resumeError = { code: 'THREAD_IN_USE', message: 'occupied' };
    expect(command(state, 'stop').unavailableReason).toContain('其他进程占用');
    state.thread!.managed = true;
    state.thread!.turns[0]!.status = 'completed';
    state.thread!.status = 'completed';
    expect(command(state, 'stop').unavailableReason).toContain('没有可中断');
    state.thread!.status = 'unknown';
    expect(command(state, 'stop').unavailableReason).toContain('状态尚未确认');
  });
});

describe('slash command execution', () => {
  it('uses project defaults for new and conversation overrides for Fork, following acknowledged IDs', async () => {
    const state = context();
    expect(await command(state, 'new').run()).toMatchObject({
      draftKey: 'project-draft',
      message: expect.stringContaining('发送首条消息时创建'),
    });
    expect(state.openDraft).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
    expect(await command(state, 'fork').run()).toMatchObject({
      draftKey: 'created-thread',
      message: '已 Fork 为新会话。',
    });
    expect(state.run).toHaveBeenLastCalledWith(
      'fork',
      'thread/one',
      '/api/threads/thread%2Fone/fork',
      { settings: { model: 'thread-override' } },
    );
  });

  it('resumes only the selected history, preserving its saved settings and refreshing its state', async () => {
    const state = context();
    expect(await command(state, 'resume').run()).toEqual({ message: '已恢复当前选中的会话。' });
    expect(state.onResumeAttempt).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledWith(
      'resume',
      'thread/one',
      '/api/threads/thread%2Fone/resume',
    );
    expect(state.refreshThread).toHaveBeenCalledOnce();
  });

  it('interrupts the latest active turn and reports acceptance without claiming the task has stopped', async () => {
    const state = context();
    activeThread(state);
    state.thread!.turns.push({
      id: 'latest',
      threadId: 'thread/one',
      status: 'waitingApproval',
      items: [],
    });
    expect(await command(state, 'stop').run()).toEqual({
      message: '已提交中断请求，请等待任务状态更新。',
    });
    expect(state.run).toHaveBeenCalledWith(
      'interrupt',
      'thread/one',
      '/api/threads/thread%2Fone/interrupt',
      { expectedTurnId: 'latest' },
    );
  });

  it.each(['accepted', 'dispatching', 'unknown', 'failed'] as const)(
    'does not report a %s receipt as success',
    async (status) => {
      const state = context();
      state.run = vi.fn().mockResolvedValue(receipt(status));
      const result = await command(state, 'fork').run();
      expect(result.error).toBe(true);
      expect(result.draftKey).toBeUndefined();
    },
  );

  it('preserves failures and missing receipts instead of claiming a new thread exists', async () => {
    const state = context();
    state.run = vi.fn().mockResolvedValue(undefined);
    expect(await command(state, 'fork').run()).toMatchObject({
      error: true,
      message: expect.stringContaining('成功回执'),
    });
    state.run = vi.fn().mockResolvedValue({ ...receipt(), result: {} });
    expect(await command(state, 'fork').run()).toMatchObject({
      error: true,
      message: expect.stringContaining('新会话标识'),
    });
    state.run = vi.fn().mockResolvedValue({
      ...receipt('failed'),
      error: { code: 'THREAD_IN_USE', message: '此会话正被其他进程使用' },
    });
    expect(await command(state, 'resume').run()).toEqual({
      error: true,
      message: '此会话正被其他进程使用',
    });
    state.run = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    expect(await command(state, 'fork').run()).toEqual({
      error: true,
      message: 'Network unavailable',
    });
  });

  it('revalidates fresh connection and selection state before dispatching a previously offered command', async () => {
    let state = context();
    const commands = createSlashCommands(() => state);
    state = { ...state, connection: 'disconnected' };
    expect(await commands.find((entry) => entry.name === 'new')!.run()).toMatchObject({
      error: true,
      message: expect.stringContaining('离线'),
    });
    state = { ...state, connection: 'connected', selectedId: 'different-thread' };
    expect(await commands.find((entry) => entry.name === 'fork')!.run()).toMatchObject({
      error: true,
      message: expect.stringContaining('已切换'),
    });
    expect(state.run).not.toHaveBeenCalled();
  });

  it('keeps help and status local, describing diagnostics accurately without claiming a refresh', async () => {
    const state = context();
    state.connection = 'disconnected';
    const help = await command(state, 'help').run();
    expect(help.message).toContain('/resume');
    expect(help.message).toContain('不是 CLI 会话选择器');
    expect(help.message).toContain('/plan [任务]');
    expect(await command(state, 'status').run()).toEqual({
      message: '已打开状态诊断；可在面板中刷新或核对提交。',
    });
    expect(state.openStatus).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.refreshThread).not.toHaveBeenCalled();
  });
});

describe('manual context compaction', () => {
  it('submits a separate operation with no prompt/settings and explains acknowledgement', async () => {
    const state = context();
    state.thread!.managed = true;
    expect(await command(state, 'compact').run()).toEqual({
      message: '已提交上下文压缩请求；进度和结果以会话中的任务状态为准。',
    });
    expect(state.run).toHaveBeenCalledWith(
      'compact',
      'thread/one',
      '/api/threads/thread%2Fone/compact',
    );
  });
  it('blocks unavailable, archived, empty, active and uncertain conversations', () => {
    const state = context();
    expect(command(state, 'compact').unavailableReason).toContain('恢复');
    state.thread!.managed = true;
    state.thread!.archived = true;
    expect(command(state, 'compact').unavailableReason).toContain('归档');
    state.thread!.archived = false;
    state.thread!.turns = [];
    expect(command(state, 'compact').unavailableReason).toContain('为空');
    state.thread!.turns = context().thread!.turns;
    state.thread!.status = 'running';
    expect(command(state, 'compact').unavailableReason).toContain('等待当前任务');
    state.thread!.status = 'unknown';
    expect(command(state, 'compact').unavailableReason).toContain('核对');
  });
});

it('opens a project draft without requiring native creation capability or mutating the running source', async () => {
  const state = context();
  activeThread(state);
  state.system!.capabilities = [];
  expect(await command(state, 'new').run()).toMatchObject({ draftKey: 'project-draft' });
  expect(state.openDraft).toHaveBeenCalledOnce();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.thread!.status).toBe('running');
});

it('supports new, rename, resume and fork in an explicitly unassigned workspace', async () => {
  const state = context();
  state.project = undefined;
  state.scopeId = '@unassigned';
  state.thread!.projectId = null;
  expect(command(state, 'new').unavailableReason).toBeUndefined();
  await command(state, 'new').run();
  expect(state.openDraft).toHaveBeenCalledOnce();
  expect(command(state, 'resume').unavailableReason).toBeUndefined();
  expect(command(state, 'fork').unavailableReason).toBeUndefined();
  state.thread!.managed = true;
  state.system!.capabilities.push('thread/name/set');
  expect(command(state, 'rename').unavailableReason).toBeUndefined();
  state.busy = ['create:@unassigned'];
  expect(command(state, 'new').unavailableReason).toContain('正在新建');
});

it('selects Plan for an idle session or draft and blocks execution or stale contexts', async () => {
  const state = context();
  state.system!.capabilities.push('turn/start');
  state.thread!.managed = true;
  state.selectPlan = vi.fn().mockResolvedValue(true);
  expect(
    validateSlashCommand(
      '/plan compare designs',
      createSlashCommands(() => state),
    ),
  ).toBeUndefined();
  await command(state, 'plan').run('compare designs');
  expect(state.selectPlan).toHaveBeenCalledWith('compare designs');
  expect(state.run).not.toHaveBeenCalled();
  activeThread(state);
  expect(await command(state, 'plan').run()).toMatchObject({ error: true });
  state.thread = undefined;
  state.selectedId = undefined;
  expect(command(state, 'plan').unavailableReason).toBeUndefined();
  const pending = command(state, 'plan');
  state.selectedId = 'different-thread';
  expect(await pending.run()).toMatchObject({ error: true });
});

import { UNASSIGNED_SCOPE } from '../shared/workspace-scope';
import { displayMessage, messageDetails } from './i18n/messages';
import { t, useInterfaceLocale } from './i18n';
import { BackupSettings } from './components/BackupSettings';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Pencil } from 'lucide-react';
import type { Settings, ThreadSummary } from '../shared/types';
import { useWorkspace } from './hooks/useWorkspace';
import { useThreadReadState } from './hooks/useThreadReadState';
import { useNewSessionShortcut } from './hooks/useNewSessionShortcut';
import { Sidebar } from './components/Sidebar';
import { FilePreviewProvider } from './components/FilePreviewProvider';
import { Conversation } from './components/Conversation';
import { ThreadTitle } from './components/ThreadTitle';
import { GithubRepositoryLink } from './components/GithubRepositoryLink';
import { Composer } from './components/Composer';
import { ActionCard } from './components/ActionCard';
import { ConnectionBadge, Diagnostics } from './components/Diagnostics';
import { isActive, Status } from './components/Status';
import { Icon } from './components/Icon';
import { Button } from './components/ui/button';
import { ControlHint } from './components/ControlHint';
import { blocksTarget } from './lib/operations';
import { createSlashCommands, type SlashCommandContext } from './lib/slash-commands';
import { downloadThreadExport } from './lib/thread-export';
import { encodeQuestionReplies } from '../shared/async-questions';
import { CompatibilityNotice } from './components/CompatibilityNotice';
import { ProjectDialog } from './components/ProjectDialog';
import { NotificationSettings } from './components/NotificationSettings';
import { GatewaySettings } from './components/GatewaySettings';
import { UpdateSettings } from './components/UpdateSettings';
import { useConversationHistory } from './hooks/useConversationHistory';
import { useUpdates } from './hooks/useUpdates';
import { useShell } from './hooks/useShell';
import { useMobileInputViewport } from './hooks/useMobileInputViewport';
import { usesMobileInput } from './lib/mobile-input';
import { ShellPanel } from './components/ShellPanel';
import { shellActive } from '../shared/shell';
import { updateActive } from '../shared/updates';
import {
  canConfirmCompatibility,
  compatibilityConfirmationRequired,
  compatibilityConfirmationInput,
  compatibilityFingerprint,
} from './lib/compatibility';

const encode = encodeURIComponent;

function WorkspaceLayout({
  threadId,
  getHistoryCursor,
  children,
}: {
  threadId?: string;
  getHistoryCursor: (targetId: string) => string | undefined;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  useMobileInputViewport(shellRef, usesMobileInput(navigator));
  return (
    <div className="app-shell" ref={shellRef}>
      <FilePreviewProvider threadId={threadId} getHistoryCursor={getHistoryCursor}>
        {children}
      </FilePreviewProvider>
    </div>
  );
}

export function App() {
  useInterfaceLocale();
  const workspace = useWorkspace();
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const shell = useShell(shellOpen);
  const [shellCollapsed, setShellCollapsed] = useState(false);
  const updates = useUpdates();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const { isUnreadCompletion, markCompletedRead } = useThreadReadState();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [gatewaySettingsOpen, setGatewaySettingsOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeMobileNavigation = () => {
      if (desktop.matches) setSidebarOpen(false);
    };
    desktop.addEventListener('change', closeMobileNavigation);
    return () => desktop.removeEventListener('change', closeMobileNavigation);
  }, []);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const statusCheck = useRef(false);
  const [projectDialog, setProjectDialog] = useState<
    { kind: 'add' } | { kind: 'manage'; id: string }
  >();
  const [checkingCompatibility, setCheckingCompatibility] = useState(false);
  const [compatibilityDialogOpen, setCompatibilityDialogOpen] = useState(false);
  const compatibilityAttempt = useRef(false);
  const project = workspace.projects.find((entry) => entry.id === workspace.projectId);
  const managedProject =
    projectDialog?.kind === 'manage'
      ? workspace.projects.find((entry) => entry.id === projectDialog.id)
      : undefined;
  useEffect(() => {
    if (projectDialog?.kind === 'manage' && !managedProject) setProjectDialog(undefined);
  }, [projectDialog, managedProject]);
  const openAddProject = () => {
    setSidebarOpen(false);
    setProjectDialog({ kind: 'add' });
  };
  const { thread, system } = workspace;
  const historyForbidden =
    workspace.authRequired ||
    Boolean(
      workspace.threadReadFailure &&
      workspace.threadReadFailure.id === workspace.selectedId &&
      [401, 403, 404].includes(workspace.threadReadFailure.status),
    );
  const history = useConversationHistory(thread, workspace.selectedId, {
    projectId: workspace.projectId,
    scope: workspace.cacheScope,
    forbidden: historyForbidden,
  });
  const { notificationTarget, clearNotificationTarget } = workspace;
  useEffect(() => {
    if (!notificationTarget || history.thread?.id !== notificationTarget.threadId || !thread)
      return;
    if (sidebarOpen || notificationSettingsOpen) {
      setSidebarOpen(false);
      setNotificationSettingsOpen(false);
      return;
    }
    const { target } = notificationTarget;
    const card = [...document.querySelectorAll<HTMLElement>('[data-attention-id]')].find(
      (element) =>
        element.dataset.attentionKind === target.kind && element.dataset.attentionId === target.id,
    );
    if (card) {
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'start' });
    } else if (
      target.kind === 'question' &&
      history.thread.history?.olderCursor &&
      !historyForbidden
    ) {
      if (!history.loading && !history.error) void history.loadOlder();
      return;
    }
    // A resolved or expired request simply opens the current conversation.
    clearNotificationTarget();
  }, [
    notificationTarget,
    history.thread,
    history.loading,
    history.error,
    history.loadOlder,
    thread,
    historyForbidden,
    clearNotificationTarget,
    sidebarOpen,
    notificationSettingsOpen,
  ]);
  const resumeAttempt = useRef<string | undefined>(undefined);
  const canControl = Boolean(
    system?.ready &&
    system.authenticated !== false &&
    workspace.connection === 'connected' &&
    !workspace.authRequired,
  );
  const canOperate =
    canControl &&
    (workspace.projectId === UNASSIGNED_SCOPE || Boolean(project?.available)) &&
    !compatibilityConfirmationRequired(system);
  const canConfirm = canConfirmCompatibility(system, workspace.connection, workspace.authRequired);
  const compatibilityTarget = compatibilityFingerprint(system) ?? '';
  const busyFor = (kind: string, target = thread?.id ?? '') =>
    workspace.busy.includes(`${kind}:${target}`);
  const unsettledFor = (target: string) =>
    workspace.operations.some((entry) => blocksTarget(entry, target));
  const creating = (projectId: string) =>
    workspace.firstMessages.includes(projectId) ||
    busyFor('create', projectId) ||
    unsettledFor(projectId);
  const canCreate = (projectId: string) =>
    canControl &&
    !workspace.savingModelDefaults &&
    !compatibilityConfirmationRequired(system) &&
    (projectId === UNASSIGNED_SCOPE ||
      Boolean(workspace.projects.find((entry) => entry.id === projectId)?.available));
  const openNewSession = (projectId: string) => {
    if (!canCreate(projectId) || creating(projectId)) return;
    workspace.setProjectId(projectId);
    setSidebarOpen(false);
    setComposerFocusRequest((request) => request + 1);
  };
  useNewSessionShortcut(canCreate(workspace.projectId) && !creating(workspace.projectId), () =>
    openNewSession(workspace.projectId),
  );
  const activeTurn = thread?.turns.findLast((turn) => isActive(turn.status));
  const actions =
    thread?.actions.filter(
      (action) =>
        action.status === 'pending' ||
        action.status === 'responding' ||
        (action.kind === 'unsupported' && action.status === 'expired'),
    ) ?? [];
  const waitingForConfirmation = thread
    ? (unsettledFor(thread.id) && !busyFor('resume')) ||
      (thread.managed && thread.status === 'unknown') ||
      (thread.execution && !thread.execution.ended && thread.status === 'unknown')
    : !busyFor('create', workspace.projectId) && unsettledFor(workspace.projectId);
  const resumeBlocked = Boolean(
    thread &&
    (!canOperate ||
      thread.archived ||
      unsettledFor(thread.id) ||
      busyFor('resume') ||
      (thread.execution && !thread.execution.ended)),
  );
  const { run, refreshThread } = workspace;
  const resumeThread = useCallback(() => {
    if (!thread || resumeBlocked) return;
    resumeAttempt.current = `${system?.codexEpoch}:${thread.id}`;
    // Preserve the saved session settings; composer overrides apply when sending a task.
    void run('resume', thread.id, `/api/threads/${encode(thread.id)}/resume`).then(() =>
      refreshThread(),
    );
  }, [thread, resumeBlocked, system?.codexEpoch, run, refreshThread]);
  useEffect(() => {
    if (!system?.ready || thread?.archived) resumeAttempt.current = undefined;
    if (!thread || thread.managed || resumeBlocked) return;
    const key = `${system?.codexEpoch}:${thread.id}`;
    if (resumeAttempt.current !== key) resumeThread();
  }, [thread, system?.ready, system?.codexEpoch, resumeBlocked, resumeThread]);
  const pendingFork = Boolean(
    thread &&
    workspace.operations.some((entry) => entry.kind === 'fork' && blocksTarget(entry, thread.id)),
  );
  const supportsFork = system?.capabilities.includes('thread/fork') ?? false;
  const isForking = (id: string) =>
    busyFor('fork', id) ||
    workspace.operations.some((entry) => entry.kind === 'fork' && blocksTarget(entry, id));
  const forkDisabledReason = (
    entry: Pick<ThreadSummary, 'id' | 'projectId' | 'historyVisible'>,
  ) => {
    if (isForking(entry.id)) return t('workspace:confirming_the_fork_wait_for_the_receipt_before');
    if (!supportsFork) return t('workspace:this_codex_version_does_not_support_session_forks');
    if (!canControl) return t('workspace:you_can_fork_once_the_connection_recovers_and');
    if (
      entry.projectId !== null &&
      !workspace.projects.find((project) => project.id === entry.projectId)?.available
    )
      return t('workspace:the_project_directory_is_unavailable_restore_access_before');
    if (compatibilityConfirmationRequired(system))
      return t('workspace:confirm_compatibility_with_the_current_codex_version_first');
    if (entry.historyVisible === false || (entry.id === thread?.id && !thread.turns.length))
      return t('workspace:send_the_first_message_to_enable_forking_saved');
    return undefined;
  };
  const forking = Boolean(thread && isForking(thread.id));
  const canFork = Boolean(thread?.turns.length && !forkDisabledReason(thread));
  const forkConversation = async (
    entry: Pick<ThreadSummary, 'id' | 'projectId' | 'historyVisible'>,
  ) => {
    if (forkDisabledReason(entry)) return;
    // Only the selected conversation has composer overrides. Other rows inherit their source settings.
    return workspace.run(
      'fork',
      entry.id,
      `/api/threads/${encode(entry.id)}/fork`,
      entry.id === thread?.id ? { settings: workspace.settings } : {},
    );
  };
  const forkThread = () => {
    if (thread && canFork) void forkConversation(thread);
  };
  const offline = workspace.connection !== 'connected';
  const compatibilityOperations = workspace.operations.filter(
    (entry) => entry.kind === 'confirmCompatibility' && entry.target === compatibilityTarget,
  );
  const compatibilitySubmitting =
    checkingCompatibility ||
    busyFor('confirmCompatibility', compatibilityTarget) ||
    compatibilityOperations.some(
      (entry) => entry.status === 'accepted' || entry.status === 'dispatching',
    );
  const compatibilityUncertain = compatibilityOperations.some(
    (entry) => entry.status === 'unknown' && !entry.operation?.reconciliation,
  );

  async function refreshStatus() {
    if (statusCheck.current) return;
    statusCheck.current = true;
    setCheckingStatus(true);
    try {
      await Promise.all([workspace.refreshSystem(), workspace.refreshThread()]);
      // Reading history may recover a terminal execution. Read its receipt afterwards.
      await workspace.refreshOperations(true);
    } finally {
      statusCheck.current = false;
      setCheckingStatus(false);
    }
  }

  async function confirmCurrentCompatibility() {
    if (!canConfirm || compatibilityAttempt.current) return;
    compatibilityAttempt.current = true;
    setCheckingCompatibility(true);
    try {
      const freshSystem = await workspace.refreshSystem();
      const input = compatibilityConfirmationInput(
        compatibilityTarget,
        freshSystem,
        workspace.connection,
        workspace.authRequired,
      );
      if (!input) return;
      // Each explicit confirmation is a new authorization. Old uncertain receipts remain auditable.
      await workspace.run(
        'confirmCompatibility',
        compatibilityTarget,
        '/api/system/compatibility/confirm',
        input,
      );
    } finally {
      compatibilityAttempt.current = false;
      setCheckingCompatibility(false);
    }
  }

  const slashContext: SlashCommandContext = {
    project,
    scopeId: workspace.projectId,
    selectedId: workspace.selectedId,
    thread,
    system,
    connection: workspace.connection,
    authRequired: workspace.authRequired,
    settings: workspace.settings,
    openDraft: workspace.openDraft,
    busy: workspace.busy,
    operations: workspace.operations,
    run: workspace.run,
    onResumeAttempt: () => {
      resumeAttempt.current = `${system?.codexEpoch}:${thread?.id}`;
    },
    refreshThread: workspace.refreshThread,
    openStatus: () => setDiagnosticsOpen(true),
    exportThread: downloadThreadExport,
    selectPlan: async (task) => {
      const settings: Settings = { ...workspace.settings, collaborationMode: 'plan' };
      workspace.setSettings(settings);
      return !task || sendMessage(task, false, undefined, settings);
    },
  };
  const slashContextRef = useRef(slashContext);
  slashContextRef.current = slashContext;
  const slashCommands = createSlashCommands(() => slashContextRef.current);
  const renameCommand = slashCommands.find((command) => command.name === 'rename')!;

  async function sendMessage(
    text: string,
    steer: boolean,
    images?: string[],
    settings = workspace.settings,
  ) {
    if (!canOperate || workspace.restoringSelection || workspace.savingModelDefaults) return false;
    if (!thread) {
      if (workspace.selectedId) return false;
      return workspace.sendFirstMessage(text, images);
    }
    if (steer && !activeTurn) return false;
    const operation = await workspace.run(
      steer ? 'steer' : 'send',
      thread.id,
      `/api/threads/${encode(thread.id)}/${steer ? 'steer' : 'turns'}`,
      steer ? { text, images, expectedTurnId: activeTurn!.id } : { text, images, settings },
      { kind: 'send', key: workspace.draftKey, text, images },
    );
    return operation?.status === 'acknowledged';
  }

  return (
    <WorkspaceLayout threadId={thread?.id} getHistoryCursor={history.getHistoryCursor}>
      <Sidebar
        onBackups={() => {
          setSidebarOpen(false);
          setBackupsOpen(true);
        }}
        onGatewaySettings={() => {
          setSidebarOpen(false);
          setGatewaySettingsOpen(true);
        }}
        onUpdates={() => {
          setSidebarOpen(false);
          setUpdatesOpen(true);
        }}
        appVersion={updates.status?.version}
        updateAvailable={Boolean(
          updates.status?.available && updates.status.available.version !== updates.status.version,
        )}
        updating={updateActive(updates.status?.run)}
        onNotificationSettings={() => {
          setSidebarOpen(false);
          setNotificationSettingsOpen(true);
        }}
        notificationStatus={
          workspace.notifications.error
            ? t('workspace:check_settings')
            : workspace.notifications.enabled && workspace.notifications.access === 'granted'
              ? t('common:on')
              : t('common:off')
        }
        archiveView={workspace.archiveView}
        onArchiveView={workspace.setArchiveView}
        onArchive={(id, archived) => {
          void workspace.archiveThread(id, archived);
        }}
        onFork={(entry) => {
          void forkConversation(entry).then((operation) => {
            if (operation?.status === 'acknowledged') setSidebarOpen(false);
          });
        }}
        forkDisabledReason={forkDisabledReason}
        forking={isForking}
        archiveDisabledReason={(entry) => {
          if (busyFor('archive', entry.id)) return t('common:saving');
          if (unsettledFor(entry.id))
            return t('workspace:check_the_session_operation_results_first');
          if (!canControl) return t('workspace:available_when_the_connection_recovers');
          if (compatibilityConfirmationRequired(system))
            return t('workspace:confirm_codex_version_compatibility_first');
          if (
            !system?.capabilities.includes(entry.archived ? 'thread/unarchive' : 'thread/archive')
          )
            return t('workspace:this_codex_version_does_not_support_this_operation');
          if (
            entry.projectId !== null &&
            !workspace.projects.find((project) => project.id === entry.projectId)?.available
          )
            return t('common:project_directory_unavailable');
          if (!entry.archived && (isActive(entry.status) || entry.pendingActionCount > 0))
            return t('workspace:finish_the_task_and_resolve_pending_requests_before');
          if (!entry.archived && entry.managed && entry.status === 'unknown')
            return t('workspace:session_state_needs_checking_archiving_is_temporarily_unavailable');
          return undefined;
        }}
        projects={workspace.projects}
        projectsLoaded={workspace.projectsLoaded}
        projectId={workspace.projectId}
        onProject={(id) => {
          workspace.setProjectId(id);
          setSidebarOpen(false);
        }}
        projectThreads={workspace.projectThreads}
        selectedId={workspace.selectedId}
        isUnreadCompletion={isUnreadCompletion}
        onThread={(id, projectId) => {
          void workspace.selectThread(id, projectId);
        }}
        onMore={(projectId, cursor) => {
          void workspace.loadProjectThreads(projectId, cursor);
        }}
        onRetry={(projectId) => {
          void workspace.loadProjectThreads(
            projectId,
            workspace.projectThreads[projectId]?.retryCursor,
          );
        }}
        onRefresh={() => {
          void workspace.refreshProjects().then(workspace.refreshProjectsThreads);
        }}
        onAddProject={openAddProject}
        onManageProject={(project) => {
          setSidebarOpen(false);
          setProjectDialog({ kind: 'manage', id: project.id });
        }}
        canManageProjects={!workspace.authRequired}
        onReorderProjects={workspace.reorderProjects}
        onCreate={openNewSession}
        creating={creating}
        canCreate={canCreate}
        offline={offline}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className={`main-panel${shellOpen && !shellCollapsed ? ' shell-visible' : ''}`}>
        <header className="topbar">
          <div className="topbar-title">
            <Button
              className="mobile-only"
              variant="ghost"
              size="icon"
              aria-label={t('workspace:open_projects_and_sessions')}
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </Button>
            <div>
              <div className="breadcrumb">
                {project?.name ?? t('common:unassigned')}
                <Icon name="chevron" size={12} />
                <span>
                  {workspace.selectedId ? t('common:sessions') : t('workspace:new_session')}
                </span>
              </div>
              {thread ? (
                <ThreadTitle
                  key={`${thread.projectId}:${thread.id}`}
                  title={thread.title || t('workspace:new_session')}
                  rename={renameCommand}
                  pending={Boolean(
                    thread &&
                    workspace.operations.some(
                      (entry) => entry.kind === 'rename' && blocksTarget(entry, thread.id),
                    ),
                  )}
                />
              ) : (
                <h1>
                  {workspace.selectedId
                    ? (history.thread?.title ??
                      workspace.threads.find((entry) => entry.id === workspace.selectedId)?.title ??
                      t('common:loading_session'))
                    : t('workspace:start_your_next_task')}
                </h1>
              )}
              {thread && thread.projectId === null && (
                <details className="workspace-directory">
                  <summary>{t('common:working_directory')}</summary>
                  <code>{thread.cwd}</code>
                </details>
              )}
            </div>
            <GithubRepositoryLink
              projectId={project?.available ? project.id : undefined}
              threadId={workspace.selectedId}
            />
          </div>
          <div className="topbar-status">
            <Button
              variant="ghost"
              size="sm"
              className="shell-entry"
              aria-label={t('workspace:open_shell_panel')}
              aria-expanded={shellOpen && !shellCollapsed}
              onClick={() => {
                setShellOpen(true);
                setShellCollapsed(false);
              }}
            >
              <Icon name="terminal" size={16} />
              <span>Shell</span>
              {shell.commands.some(shellActive) && (
                <span
                  className="shell-entry-count"
                  aria-label={t('workspace:running_shell_commands')}
                >
                  {shell.commands.filter(shellActive).length}
                </span>
              )}
            </Button>
            {thread && <Status status={thread.status} offline={offline} />}
            <ConnectionBadge connection={workspace.connection} />
            {thread?.forkedFromId && (
              <ControlHint
                id="thread-source-hint"
                content={t('workspace:return_to_original_session')}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('workspace:return_to_original_session')}
                  aria-describedby="thread-source-hint"
                  onClick={() => {
                    void workspace.selectThread(thread.forkedFromId!);
                  }}
                >
                  <ArrowLeft size={16} />
                </Button>
              </ControlHint>
            )}
            <Diagnostics
              system={system}
              connection={workspace.connection}
              operations={workspace.operations}
              thread={thread}
              selectedId={workspace.selectedId}
              threadReadFailed={Boolean(workspace.threadReadFailure?.id === workspace.selectedId)}
              busy={workspace.busy}
              open={diagnosticsOpen}
              onOpenChange={setDiagnosticsOpen}
              refreshing={checkingStatus}
              onDiscardMissing={workspace.discardMissingOperation}
              onRefresh={() => {
                void refreshStatus();
                if (offline) workspace.retryConnection();
              }}
              onReconcile={(id) => {
                void workspace
                  .run('reconcile', id, `/api/operations/${encode(id)}/reconcile`, {
                    confirmEnded: true,
                  })
                  .then((operation) => {
                    if (operation?.status === 'acknowledged') return refreshStatus();
                  });
              }}
            />
          </div>
        </header>
        {system?.demo && (
          <div className="demo-banner">
            {t('workspace:simulation_mode_results_come_from_the_explicitly_enabled')}
          </div>
        )}
        {workspace.authRequired ? (
          <div className="error-banner persistent-banner" role="alert">
            <Icon name="alert" />
            {t('workspace:your_login_has_expired_disconnecting_this_page_does')}
            <a className="button button-secondary button-small" href="/">
              {t('workspace:reopen_login')}
            </a>
          </div>
        ) : (
          offline && (
            <div className="connection-banner" role="status">
              <span>
                {t('workspace:live_connection_showing_the_last_known_state', {
                  v0:
                    workspace.connection === 'connecting'
                      ? t('workspace:connecting')
                      : t('workspace:disconnected_reconnecting'),
                })}
              </span>
              <Button variant="ghost" size="sm" onClick={workspace.retryConnection}>
                {t('workspace:reconnect_now')}
              </Button>
            </div>
          )
        )}
        {system && !system.ready && (
          <div className="error-banner persistent-banner" role="alert">
            {t('workspace:codex_is_unavailable', {
              v0:
                system.error ??
                t('workspace:check_the_codex_installation_authentication_and_service_on'),
            })}
          </div>
        )}
        <CompatibilityNotice
          system={system}
          onOpenChange={setCompatibilityDialogOpen}
          canConfirm={canConfirm}
          submitting={compatibilitySubmitting}
          uncertain={compatibilityUncertain}
          error={displayMessage(workspace.error)}
          onRefresh={() => {
            void workspace.refreshSystem();
            void workspace.refreshOperations();
          }}
          onConfirm={() => {
            void confirmCurrentCompatibility();
          }}
          onReconfirm={() => {
            void confirmCurrentCompatibility();
          }}
        />
        {workspace.error && (
          <div className="error-banner dismissible" role="alert">
            <div>
              <span>{displayMessage(workspace.error)}</span>
              {messageDetails(workspace.error) && (
                <details className="error-technical">
                  <summary>{t('common:technical_details')}</summary>
                  <pre>{messageDetails(workspace.error)}</pre>
                </details>
              )}
              {workspace.errorDetails !== undefined && (
                <details className="raw-details">
                  <summary>{t('workspace:error_details')}</summary>
                  <pre>{JSON.stringify(workspace.errorDetails, null, 2)}</pre>
                </details>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('workspace:dismiss_error')}
              onClick={workspace.clearError}
            >
              <Icon name="close" size={15} />
            </Button>
          </div>
        )}
        {workspace.operations
          .filter((entry) => entry.mutation)
          .map((entry) => (
            <div
              className="archive-notice mutation-notice"
              role="status"
              key={entry.clientOperationId}
            >
              {entry.kind === 'rename' ? <Pencil size={16} /> : <Icon name="archive" size={16} />}
              <span>
                {entry.kind === 'rename'
                  ? entry.status === 'unknown'
                    ? t('workspace:rename_result_awaiting_confirmation')
                    : t('workspace:saving_session_name')
                  : entry.mutation!.archived
                    ? entry.status === 'unknown'
                      ? t('workspace:archive_result_awaiting_confirmation')
                      : t('workspace:archiving_session')
                    : entry.status === 'unknown'
                      ? t('workspace:unarchive_result_awaiting_confirmation')
                      : t('workspace:unarchiving')}
              </span>
              {entry.status === 'unknown' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={checkingStatus}
                  onClick={() => void refreshStatus()}
                >
                  {checkingStatus ? t('common:checking') : t('workspace:check_submission')}
                </Button>
              )}
            </div>
          ))}
        {thread?.archived && (
          <div className="archive-notice" role="status">
            <Icon name="archive" size={18} />
            <div>
              <strong>{t('workspace:this_session_is_archived')}</strong>
              <p>{t('workspace:history_is_preserved_unarchive_to_continue_the_conversation')}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={
                !canOperate ||
                unsettledFor(thread.id) ||
                busyFor('archive') ||
                !system?.capabilities.includes('thread/unarchive')
              }
              onClick={() => {
                void workspace.archiveThread(thread.id, false);
              }}
            >
              {busyFor('archive') ? t('common:saving') : t('common:unarchive')}
            </Button>
          </div>
        )}
        <Conversation
          thread={history.thread}
          retryControls={{
            disabled: !canOperate || !thread?.managed || Boolean(thread?.archived),
            busy: busyFor('retry') || busyFor('cancelRetry'),
            onCancel: () => {
              if (thread?.capacityRetry)
                void workspace.run(
                  'cancelRetry',
                  thread.id,
                  `/api/threads/${encode(thread.id)}/retry/cancel`,
                  { expectedTurnId: thread.capacityRetry.rootTurnId },
                );
            },
            onRetry: (turnId) => {
              if (thread)
                void workspace.run('retry', thread.id, `/api/threads/${encode(thread.id)}/retry`, {
                  expectedTurnId: turnId,
                  settings: workspace.settings,
                });
            },
          }}
          history={{
            cached: history.cached,
            cacheExhausted: history.cacheExhausted,
            onLoadCachedOlder: history.loadCachedOlder,
            syncError: !thread ? workspace.error : history.error,
            loading: history.loading,
            error: history.error,
            onLoadOlder: history.loadOlder,
            opening: Boolean(workspace.selectedId && !thread),
            openingError: !thread ? workspace.error : undefined,
            onRetryOpen: () => {
              workspace.clearError();
              if (history.error) void history.loadOlder();
              void workspace.refreshThread();
            },
          }}
          readingEnabled={
            !sidebarOpen &&
            !projectDialog &&
            !diagnosticsOpen &&
            !workspace.authRequired &&
            !compatibilityDialogOpen
          }
          onReadCompleted={markCompletedRead}
          offline={offline}
          projectName={project?.name}
          needsProject={workspace.projectsLoaded && workspace.projects.length === 0}
          canAddProject={!workspace.authRequired}
          onAddProject={openAddProject}
          questionControls={{
            disabled:
              !canOperate ||
              !thread?.managed ||
              Boolean(thread.archived) ||
              Boolean(waitingForConfirmation) ||
              busyFor('send') ||
              busyFor('steer') ||
              busyFor('resume'),
            onReply: async (replies) =>
              sendMessage(encodeQuestionReplies(replies), Boolean(activeTurn)),
          }}
        />
        <div className="bottom-region">
          {actions.length > 0 && (
            <div className="pending-actions" aria-label={t('workspace:pending_requests')}>
              {actions.map((action) => (
                <ActionCard
                  key={action.actionId}
                  action={action}
                  disabled={
                    !canOperate ||
                    busyFor('resolve', action.actionId) ||
                    unsettledFor(action.actionId)
                  }
                  onResolve={(resolution) => {
                    void workspace.run(
                      'resolve',
                      action.actionId,
                      `/api/actions/${encode(action.actionId)}/resolve`,
                      { resolution },
                    );
                  }}
                />
              ))}
            </div>
          )}
          {waitingForConfirmation && (
            <div className="pending-notice" role="status">
              <Icon name="alert" size={15} />
              <span>
                {!thread
                  ? t('workspace:the_new_session_submission_is_unconfirmed_check_it')
                  : pendingFork
                    ? t('workspace:the_fork_result_is_unconfirmed_check_the_submission')
                    : t('workspace:the_submission_result_is_unconfirmed_check_it_or')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={checkingStatus}
                aria-expanded={diagnosticsOpen}
                aria-controls="diagnostics-panel"
                onClick={() => {
                  setDiagnosticsOpen(true);
                  void refreshStatus();
                }}
              >
                {checkingStatus ? t('common:checking') : t('workspace:check_submission')}
              </Button>
              {thread && !pendingFork && (
                <Button variant="secondary" size="sm" disabled={!canFork} onClick={forkThread}>
                  {t('common:fork_into_a_new_session')}
                </Button>
              )}
            </div>
          )}
          <Composer
            focusRequest={composerFocusRequest}
            commands={slashCommands}
            thread={thread}
            threadLoading={workspace.restoringSelection || Boolean(workspace.selectedId && !thread)}
            draftKey={workspace.draftKey}
            sentDrafts={workspace.sentDrafts}
            projectName={project?.name}
            projectId={
              workspace.projectId === UNASSIGNED_SCOPE
                ? UNASSIGNED_SCOPE
                : project?.available
                  ? project.id
                  : undefined
            }
            runtimeKey={
              system?.ready && workspace.connection === 'connected'
                ? `${system.codexEpoch}:${workspace.runtimeDefaultsRevision}`
                : undefined
            }
            settings={workspace.settings}
            models={system?.models ?? []}
            onSettings={workspace.setSettings}
            onSaveModelDefaults={workspace.saveModelDefaults}
            savingModelDefaults={workspace.savingModelDefaults}
            disabled={
              !canOperate ||
              workspace.restoringSelection ||
              Boolean(waitingForConfirmation) ||
              Boolean(thread?.archived)
            }
            canInterrupt={
              canControl &&
              Boolean(thread?.managed && (activeTurn || thread.capacityRetry?.status === 'waiting'))
            }
            submitting={
              workspace.firstMessages.includes(workspace.projectId) ||
              busyFor('send') ||
              busyFor('steer')
            }
            interrupting={busyFor('interrupt')}
            resuming={busyFor('resume')}
            canResume={!resumeBlocked}
            resumeAttempted={resumeAttempt.current === `${system?.codexEpoch}:${thread?.id}`}
            canFork={canFork}
            forking={forking}
            onFork={forkThread}
            onResume={resumeThread}
            onInterrupt={() => {
              if (thread?.capacityRetry?.status === 'waiting') {
                void workspace.run(
                  'cancelRetry',
                  thread.id,
                  `/api/threads/${encode(thread.id)}/retry/cancel`,
                  { expectedTurnId: thread.capacityRetry.rootTurnId },
                );
                return;
              }
              if (thread && activeTurn)
                void workspace.run(
                  'interrupt',
                  thread.id,
                  `/api/threads/${encode(thread.id)}/interrupt`,
                  { expectedTurnId: activeTurn.id },
                );
            }}
            onSend={sendMessage}
          />
        </div>
        <ShellPanel
          open={shellOpen}
          project={project}
          shell={shell}
          canExecute={canOperate && Boolean(system?.capabilities.includes('command/exec'))}
          collapsed={shellCollapsed}
          onCollapse={() => setShellCollapsed((value) => !value)}
          onClose={() => setShellOpen(false)}
        />
      </main>
      {projectDialog && (projectDialog.kind === 'add' || managedProject) && (
        <ProjectDialog
          key={projectDialog.kind === 'add' ? 'add' : projectDialog.id}
          project={managedProject}
          disabled={workspace.authRequired}
          onAdd={workspace.addProject}
          onImported={workspace.openImportedProject}
          onRename={workspace.renameProject}
          onRemove={workspace.removeProject}
          onClose={() =>
            setProjectDialog((current) => (current === projectDialog ? undefined : current))
          }
        />
      )}
      {notificationSettingsOpen && (
        <NotificationSettings
          notifications={workspace.notifications}
          onClose={() => setNotificationSettingsOpen(false)}
        />
      )}
      {backupsOpen && <BackupSettings onClose={() => setBackupsOpen(false)} />}
      {gatewaySettingsOpen && <GatewaySettings onClose={() => setGatewaySettingsOpen(false)} />}
      {updatesOpen && <UpdateSettings updates={updates} onClose={() => setUpdatesOpen(false)} />}
    </WorkspaceLayout>
  );
}

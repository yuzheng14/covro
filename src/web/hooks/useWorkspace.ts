import { t } from '../i18n';
import { UNASSIGNED_SCOPE, scopeKey, scopeApi } from '../../shared/workspace-scope';
import { errorMessage } from '../lib/error-message';
import { message } from '../i18n/messages';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Cursor,
  AttentionTarget,
  Operation,
  Project,
  Settings,
  ModelDefaults,
  ModelDefaultsResult,
  SystemInfo,
  ThreadSummary,
  ThreadMutationResult,
  ThreadView,
} from '../../shared/types';
import { toThreadSummary } from '../../shared/thread-summary';
import { submittedUserMessage } from '../../shared/user-message';
import { messageConfirmed, withPendingMessages } from '../lib/pending-user-messages';
import type { PendingUserMessage } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { pendingSettings } from '../lib/settings';
import { readSessionSettings, saveSessionSettings } from '../lib/session-settings';
import {
  blocksTarget,
  canDiscardMissingOperation,
  isSettled,
  operationLookupError,
  operationThreadId,
  readOperations,
  saveOperations,
  type SavedOperation,
  type ThreadMutation,
} from '../lib/operations';
import { ThreadStream, type ConnectionState } from '../lib/realtime';
import { readableError } from '../lib/utils';
import { operationNeedsCompatibilityConfirmation } from '../lib/compatibility';
import { SystemSnapshotGuard } from '../lib/system';
import { ProjectThreadsStore } from '../lib/project-threads';
import { readThreadPage } from '../lib/thread-pagination';
import { ThreadListCache } from '../lib/thread-list-cache';
import { useDeviceCacheScope } from './useDeviceCacheScope';
import { useBrowserNotifications } from './useBrowserNotifications';
import {
  ConversationDrafts,
  type DraftSubmission,
  type SentDraft,
} from '../lib/conversation-drafts';
import { useUpgradeReloadState } from '../lib/upgrade-reload';

function preferredProject() {
  try {
    return localStorage.getItem('codex-web.project') ?? '';
  } catch {
    return '';
  }
}

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const projectsLoadedRef = useRef(false);
  const projectRevision = useRef(0);
  const projectReadSequence = useRef(0);
  const [projectId, setActiveProjectId] = useState(preferredProject);
  const projectsRef = useRef<Project[]>([]);
  const [operations, setOperations] = useState<SavedOperation[]>(readOperations);
  const operationsRef = useRef(operations);
  const projectStore = useRef(new ProjectThreadsStore(operations));
  const [archiveView, setArchiveView] = useState(false);
  const listBatch = useRef<{ queued: Set<string>; reading: Set<string> } | undefined>(undefined);
  const [projectThreads, setProjectThreads] = useState(projectStore.current.snapshot);
  const [thread, setThread] = useState<ThreadView>();
  const [localSubmissions, setLocalSubmissions] = useState<Record<string, PendingUserMessage>>({});
  const settleSubmission = useCallback(
    (id: string, status: PendingUserMessage['status'], turnId?: string) => {
      setLocalSubmissions((previous) =>
        previous[id]
          ? {
              ...previous,
              [id]: { ...previous[id], status, ...(turnId ? { turnId } : {}) },
            }
          : previous,
      );
    },
    [],
  );
  const [threadReadFailure, setThreadReadFailure] = useState<{ id: string; status: number }>();
  const [selectedId, setSelectedId] = useState<string>();
  const [notificationTarget, setNotificationTarget] = useState<{
    threadId: string;
    target: AttentionTarget;
  }>();
  const clearNotificationTarget = useCallback(() => setNotificationTarget(undefined), []);
  const selectedRef = useRef<string | undefined>(undefined);
  const selectedThreadRef = useRef<ThreadView | undefined>(undefined);
  const selectionsRef = useRef<Record<string, string>>({});
  const [system, setSystem] = useState<SystemInfo>();
  const systemSnapshotGuard = useRef(new SystemSnapshotGuard());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string>();
  const [errorThreadId, setErrorThreadId] = useState<string>();
  const errorOperation = useRef<string | undefined>(undefined);
  const [errorDetails, setErrorDetails] = useState<unknown>();
  const [authRequired, setAuthRequired] = useState(false);
  const cacheScope = useDeviceCacheScope(
    authRequired || connection === 'authenticationRequired',
    connection,
    projects,
    system,
  );
  const listCache = useMemo(
    () => (cacheScope ? new ThreadListCache(cacheScope) : undefined),
    [cacheScope],
  );
  const persistedLists = useMemo(() => new Map<string, ThreadSummary[]>(), [listCache]);
  const listCacheRef = useRef(listCache);
  const listReads = useRef(new Map<string, AbortController>());
  listCacheRef.current = listCache;
  const cacheProjects = JSON.stringify([
    UNASSIGNED_SCOPE,
    ...projects.filter((project) => project.available).map((project) => project.id),
  ]);
  useLayoutEffect(() => {
    // A changed or no longer confirmed identity must not keep another scope's reading rows.
    if (projectStore.current.discardCached()) setProjectThreads(projectStore.current.snapshot);
  }, [listCache]);
  useEffect(() => {
    let active = true;
    const store = projectStore.current;
    for (const id of JSON.parse(cacheProjects) as string[])
      void listCache?.read(id, archiveView).then((rows) => {
        if (
          active &&
          rows &&
          (id === UNASSIGNED_SCOPE ||
            projectsRef.current.some((project) => project.id === id && project.available)) &&
          store.restoreCached(id, rows)
        )
          setProjectThreads(store.snapshot);
      });
    return () => {
      active = false;
    };
  }, [listCache, cacheProjects, archiveView]);
  useEffect(() => {
    if (!listCache) return;
    // Coalesce overview bursts and keep optimistic intents out of persistent snapshots.
    const timer = setTimeout(() => {
      for (const id of JSON.parse(cacheProjects) as string[]) {
        const page = projectStore.current.snapshot[id];
        const rows = projectStore.current.cacheRows(id);
        const key = `${id}:${archiveView}`;
        if (rows && page?.loaded && persistedLists.get(key) !== rows) {
          persistedLists.set(key, rows);
          void listCache.write(id, archiveView, rows);
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [listCache, persistedLists, cacheProjects, archiveView, projectThreads]);
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef(new Set<string>());
  const streamRef = useRef<ThreadStream | undefined>(undefined);
  const projectRef = useRef(projectId);
  const [settingsByScope, setSettingsByScope] = useState(readSessionSettings);
  const settingsRef = useRef<Record<string, Settings>>(settingsByScope);
  const liveSettingsQueue = useRef(new Map<string, Promise<unknown>>());
  const conversationDrafts = useRef(new ConversationDrafts());
  const [sentDrafts, setSentDrafts] = useState<Record<string, SentDraft>>({});
  const firstMessagesRef = useRef(new Set<string>());
  const [firstMessages, setFirstMessages] = useState<string[]>([]);
  useEffect(() => saveSessionSettings(settingsByScope), [settingsByScope]);
  useUpgradeReloadState(
    'workspace',
    () => ({ settings: settingsRef.current, keys: conversationDrafts.current.snapshotKeys() }),
    (saved) => {
      conversationDrafts.current.restoreKeys(saved.keys);
      settingsRef.current = { ...saved.settings, ...settingsRef.current };
      setSettingsByScope(settingsRef.current);
    },
  );
  const [runtimeDefaultsRevision, setRuntimeDefaultsRevision] = useState(0);
  const navigationRevision = useRef(0);
  const mutationNavigation = useRef(
    new Map<
      string,
      {
        projectId: string;
        threadId: string;
        revision: number;
        archived: boolean;
        left: boolean;
      }
    >(),
  );
  const detailReadSequence = useRef(0);
  const selectionRestoreRef = useRef<number | undefined>(undefined);
  const [restoringSelection, setRestoringSelection] = useState(false);
  const getProjectSettings = useCallback(
    (id: string) => settingsRef.current[`project:${id}`] ?? {},
    [],
  );
  const setSettings = useCallback((next: Settings) => {
    const scope = selectedRef.current
      ? `thread:${selectedRef.current}`
      : `project:${projectRef.current}`;
    settingsRef.current = { ...settingsRef.current, [scope]: next };
    setSettingsByScope(settingsRef.current);
  }, []);

  const report = useCallback((problem: unknown, threadId?: string, operationId?: string) => {
    errorOperation.current = operationId;
    setError(readableError(problem));
    setErrorThreadId(threadId);
    setErrorDetails(problem instanceof HttpError ? problem.problem.details : undefined);
    if (problem instanceof HttpError && problem.authenticationRequired) setAuthRequired(true);
  }, []);
  const refreshSystem = useCallback(async () => {
    const read = systemSnapshotGuard.current.beginRead();
    try {
      const next = await api.system();
      if (systemSnapshotGuard.current.canApplyRead(read)) {
        setSystem(next);
        return next;
      }
    } catch (problem) {
      if (systemSnapshotGuard.current.canApplyRead(read)) report(problem);
    }
  }, [report]);
  const track = useCallback((update: (previous: SavedOperation[]) => SavedOperation[]) => {
    const next = update(operationsRef.current);
    operationsRef.current = next;
    setOperations(next);
    if (!saveOperations(next))
      setError(message('workspace:the_browser_cannot_save_operation_records_keep_this'));
  }, []);
  const loadProjectThreads = useCallback(
    async (id: string, cursor?: string) => {
      if (
        id !== UNASSIGNED_SCOPE &&
        !projectsRef.current.some((project) => project.id === id && project.available)
      )
        return;
      const store = projectStore.current;
      const previous = store.snapshot[id];
      // React may not have rendered the disabled button yet; guard synchronously as well.
      if (previous?.loading && Boolean(cursor) === Boolean(previous.appending)) return;
      if (cursor && (previous?.loading || previous?.nextCursor !== cursor)) return;
      const archived = store.archived;
      const unverified = new Set(previous?.unverified);
      const knownIds = new Set(
        cursor
          ? previous?.data.filter((thread) => !unverified.has(thread.id)).map((thread) => thread.id)
          : [],
      );
      listReads.current.get(id)?.abort();
      const controller = new AbortController();
      listReads.current.set(id, controller);
      const read = store.beginRead(id, Boolean(cursor));
      setProjectThreads(projectStore.current.snapshot);
      try {
        // Bound the entire filtered-page scan, including response bodies, to one request budget.
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
        const page = await readThreadPage({
          projectId: id,
          archived,
          cursor,
          knownIds,
          read: (next) => api.threads(id, next, archived, signal),
          isCurrent: () => store.isCurrent(read),
        });
        if (page && store.finishRead(read, page)) setProjectThreads(store.snapshot);
      } catch (problem) {
        const forbidden = problem instanceof HttpError && [401, 403, 404].includes(problem.status);
        if (forbidden && store.isCurrent(read)) void listCacheRef.current?.remove(id);
        if (store.failRead(read, readableError(problem), cursor, forbidden))
          setProjectThreads(projectStore.current.snapshot);
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
      } finally {
        if (listReads.current.get(id) === controller) listReads.current.delete(id);
      }
    },
    [report],
  );
  const loadProjectThreadLists = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      if (listBatch.current) {
        for (const id of ids)
          if (!listBatch.current.reading.has(id)) listBatch.current.queued.add(id);
        return;
      }

      const batch = { queued: new Set(ids), reading: new Set<string>() };
      listBatch.current = batch;
      const load = async () => {
        while (listBatch.current === batch) {
          const active = projectRef.current;
          const id = batch.queued.has(active) ? active : batch.queued.values().next().value;
          if (id === undefined) {
            if (batch.reading.size === 0) listBatch.current = undefined;
            return;
          }
          batch.queued.delete(id);
          batch.reading.add(id);
          await loadProjectThreads(id);
          batch.reading.delete(id);
        }
      };
      // Share the slots across overview refreshes. A waiting active project gets the next slot.
      for (let slot = 0; slot < 4 && batch.queued.size > 0; slot++) void load();
    },
    [loadProjectThreads],
  );
  const refreshProjectsThreads = useCallback(
    () =>
      loadProjectThreadLists([
        UNASSIGNED_SCOPE,
        ...projectsRef.current.filter((entry) => entry.available).map((entry) => entry.id),
      ]),
    [loadProjectThreadLists],
  );
  const changeArchiveView = useCallback(
    (archived: boolean) => {
      if (!projectStore.current.setArchived(archived)) return;
      listBatch.current = undefined;
      for (const read of listReads.current.values()) read.abort();
      setArchiveView(archived);
      setProjectThreads(projectStore.current.snapshot);
      void refreshProjectsThreads();
    },
    [refreshProjectsThreads],
  );
  const forgetSelection = useCallback((id: string, project: string) => {
    if (selectionsRef.current[project] === id) delete selectionsRef.current[project];
    try {
      if (localStorage.getItem(`codex-web.selected:${project}`) === id)
        localStorage.removeItem(`codex-web.selected:${project}`);
    } catch {
      /* In-memory selections still work when storage is unavailable. */
    }
  }, []);
  const clearSelection = useCallback(() => {
    const id = selectedRef.current;
    if (id) forgetSelection(id, projectRef.current);
    // Invalidate reads started before leaving the conversation.
    navigationRevision.current++;
    detailReadSequence.current++;
    selectedRef.current = undefined;
    selectedThreadRef.current = undefined;
    setSelectedId(undefined);
    setThread(undefined);
    streamRef.current?.select(undefined);
  }, [forgetSelection]);
  const updateSummary = useCallback(
    (summary: ThreadSummary, cursor: Cursor) => {
      if (
        summary.projectId !== null &&
        !projectsRef.current.some((project) => project.id === summary.projectId)
      )
        return;
      if (projectStore.current.applySummary(summary, cursor)) {
        streamRef.current?.observe(summary, cursor);
        setProjectThreads(projectStore.current.snapshot);
        if (summary.archived && !projectStore.current.archived)
          forgetSelection(summary.id, scopeKey(summary.projectId));
      }
    },
    [forgetSelection],
  );
  const updateThread = useCallback(
    (next: ThreadView) => {
      if (
        next.projectId !== null &&
        !projectsRef.current.some((project) => project.id === next.projectId)
      )
        return;
      setLocalSubmissions((previous) => {
        const owned = new Set(next.pendingMessages?.map((message) => message.id));
        const entries = Object.entries(previous).filter(
          ([id, message]) =>
            message.threadId !== next.id || (!owned.has(id) && !messageConfirmed(next, message)),
        );
        return entries.length === Object.keys(previous).length
          ? previous
          : Object.fromEntries(entries);
      });
      if (next.id === selectedRef.current && scopeKey(next.projectId) === projectRef.current) {
        setThreadReadFailure(undefined);
        const previous = selectedThreadRef.current;
        const visible = projectStore.current.project(next);
        if (visible.archived && previous?.id === next.id && !previous.archived) {
          // A confirmed archive ends the current visit. Opening archived history is
          // an explicit selection, with no previous detail, and still follows its view.
          clearSelection();
        } else {
          selectedThreadRef.current = next;
          setThread(next);
          changeArchiveView(Boolean(visible.archived));
          if (next.historyVisible) {
            try {
              // Another tab may have discarded this selection while it was empty.
              localStorage.setItem(`codex-web.selected:${scopeKey(next.projectId)}`, next.id);
            } catch {
              /* Preferences are optional. */
            }
          }
        }
      }
      const actionRecords = operationsRef.current.filter(
        (entry) =>
          entry.kind === 'resolve' &&
          next.actions.some((action) => action.actionId === entry.target),
      );
      if (actionRecords.length)
        track((previous) =>
          previous.flatMap((entry) => {
            if (!actionRecords.includes(entry)) return [entry];
            const action = next.actions.find((candidate) => candidate.actionId === entry.target)!;
            if (
              ['responded', 'expired'].includes(action.status) &&
              !busyRef.current.has(`${entry.kind}:${entry.target}`)
            ) {
              if (errorOperation.current === entry.clientOperationId) setError(undefined);
              return [];
            }
            return [
              {
                ...entry,
                context: { threadId: next.id, projectId: next.projectId, title: next.title },
              },
            ];
          }),
        );
      const scope = `thread:${next.id}`;
      const draft = settingsRef.current[scope];
      if (draft && next.runtimeSettings) {
        const pending = pendingSettings(draft, next.runtimeSettings);
        if (Object.keys(pending).length !== Object.keys(draft).length) {
          settingsRef.current = { ...settingsRef.current, [scope]: pending };
          setSettingsByScope(settingsRef.current);
        }
      }
      if (
        next.execution &&
        !next.execution.ended &&
        !operationsRef.current.some(
          (entry) => entry.clientOperationId === next.execution?.operationId,
        )
      ) {
        const execution = next.execution;
        // A new device can discover a durable execution without possessing the original browser storage.
        track((previous) => [
          ...previous,
          {
            clientOperationId: execution.operationId,
            kind: 'send',
            target: next.id,
            context: { threadId: next.id, projectId: next.projectId, title: next.title },
            createdAt: Date.now(),
            status: 'unknown',
          },
        ]);
      }
    },
    [track, changeArchiveView, clearSelection],
  );
  const activateProject = useCallback((id: string) => {
    // Change ownership synchronously, before any callbacks can issue project-scoped requests.
    projectRef.current = id;
    setActiveProjectId(id);
    try {
      localStorage.setItem('codex-web.project', id);
    } catch {
      /* Preferences are optional. */
    }
  }, []);
  const selectThread = useCallback(
    async (id: string, owningProjectId?: string, restoring = false) => {
      const revision = navigationRevision.current;
      const read = ++detailReadSequence.current;
      if (!restoring) {
        selectionRestoreRef.current = undefined;
        setRestoringSelection(false);
      }
      setThreadReadFailure(undefined);
      let project =
        owningProjectId ??
        projectStore.current.findProject(id) ??
        (streamRef.current?.cache.get(id)
          ? scopeKey(streamRef.current.cache.get(id)!.data.projectId)
          : undefined);
      let loaded: ThreadView | undefined;
      const discardRestoredSelection = () => {
        if (project) {
          delete selectionsRef.current[project];
          try {
            localStorage.removeItem(`codex-web.selected:${project}`);
          } catch {
            /* Preferences are optional. */
          }
        }
        selectedRef.current = undefined;
        selectedThreadRef.current = undefined;
        setSelectedId(undefined);
        setThread(undefined);
        streamRef.current?.select(undefined);
      };
      if (project && restoring) {
        activateProject(project);
        selectedRef.current = id;
        selectedThreadRef.current = undefined;
        setSelectedId(id);
        setThread(undefined);
      }
      if (!project || restoring) {
        // Check remembered selections before subscribing: opening an empty draft
        // would otherwise automatically resume it and put it back into history.
        try {
          loaded = await api.threadMetadata(id);
          if (navigationRevision.current !== revision || detailReadSequence.current !== read)
            return;
          if (project && scopeKey(loaded.projectId) !== project) return;
          project ??= scopeKey(loaded.projectId);
          if (
            restoring &&
            loaded.historyVisible === false &&
            !operationsRef.current.some((entry) => blocksTarget(entry, id))
          ) {
            discardRestoredSelection();
            return;
          }
          if (restoring) loaded = undefined;
        } catch (problem) {
          if (navigationRevision.current === revision && detailReadSequence.current === read) {
            if (
              restoring &&
              problem instanceof HttpError &&
              problem.problem.code === 'THREAD_NOT_FOUND' &&
              !operationsRef.current.some((entry) => blocksTarget(entry, id))
            )
              discardRestoredSelection();
            else {
              if (problem instanceof HttpError)
                setThreadReadFailure({ id, status: problem.status });
              report(problem);
            }
          }
          return;
        }
      }
      if (
        project !== UNASSIGNED_SCOPE &&
        !projectsRef.current.some((entry) => entry.id === project)
      )
        return;
      activateProject(project);
      selectedRef.current = id;
      selectionsRef.current[project] = id;
      setSelectedId(id);
      const stream = streamRef.current;
      const cached = stream?.view(id);
      // Archive transitions invalidate previously visited detail independently of sidebar loading.
      if (cached && Boolean(cached.archived) !== projectStore.current.archived) stream?.forget(id);
      stream?.select(id, project === UNASSIGNED_SCOPE ? null : project);
      const initial = stream?.view(id);
      selectedThreadRef.current = initial;
      setThread(initial);
      if (initial) updateThread(initial);
      try {
        localStorage.setItem(`codex-web.selected:${project}`, id);
      } catch {
        /* Preferences are optional. */
      }
    },
    [activateProject, report, updateThread],
  );
  const selectProject = useCallback(
    (id: string, restore = false) => {
      activateProject(id);
      detailReadSequence.current++;
      selectedRef.current = undefined;
      selectedThreadRef.current = undefined;
      setSelectedId(undefined);
      setThread(undefined);
      streamRef.current?.select(undefined);
      let remembered = selectionsRef.current[id];
      try {
        remembered ??= localStorage.getItem(`codex-web.selected:${id}`) ?? undefined;
      } catch {
        /* In-memory selections still work when storage is unavailable. */
      }
      if (!restore) {
        delete selectionsRef.current[id];
        try {
          localStorage.removeItem(`codex-web.selected:${id}`);
        } catch {
          /* Preferences are optional. */
        }
      }
      if (restore && id && remembered) {
        const pending = selectThread(remembered, id, true);
        const read = detailReadSequence.current;
        selectionRestoreRef.current = read;
        setRestoringSelection(true);
        void pending.finally(() => {
          if (selectionRestoreRef.current !== read) return;
          selectionRestoreRef.current = undefined;
          setRestoringSelection(false);
        });
        return;
      }
      selectionRestoreRef.current = undefined;
      setRestoringSelection(false);
    },
    [activateProject, selectThread],
  );
  const applyProjects = useCallback(
    (data: Project[], refreshLists = false) => {
      const initial = !projectsLoadedRef.current;
      const ids = new Set([UNASSIGNED_SCOPE, ...data.map((entry) => entry.id)]);
      const removed = projectsRef.current.filter((entry) => !ids.has(entry.id));
      if (removed.length > 0) {
        if (!ids.has(projectRef.current)) {
          navigationRevision.current++;
          detailReadSequence.current++;
        }
        for (const project of removed) {
          listReads.current.get(project.id)?.abort();
          projectStore.current.removeProject(project.id);
          void listCacheRef.current?.remove(project.id);
          streamRef.current?.removeProject(project.id);
        }
        setProjectThreads(projectStore.current.snapshot);
      }
      const added = data.filter(
        (entry) =>
          entry.available &&
          !projectsRef.current.some((project) => project.id === entry.id && project.available),
      );
      projectsRef.current = data;
      setProjects(data);
      const preferred = projectRef.current;
      if (initial || !ids.has(preferred)) {
        selectProject(
          ids.has(preferred)
            ? preferred
            : (data.find((entry) => entry.available)?.id ?? data[0]?.id ?? UNASSIGNED_SCOPE),
          initial,
        );
      }
      projectsLoadedRef.current = true;
      setProjectsLoaded(true);
      if (initial || refreshLists) void refreshProjectsThreads();
      else void loadProjectThreadLists(added.map((project) => project.id));
    },
    [loadProjectThreadLists, refreshProjectsThreads, selectProject],
  );
  const refreshProjects = useCallback(
    async (refreshLists = false) => {
      const sequence = ++projectReadSequence.current;
      const revision = projectRevision.current;
      try {
        const { data } = await api.projects();
        if (sequence !== projectReadSequence.current) return;
        if (revision === projectRevision.current) applyProjects(data, refreshLists);
        else if (refreshLists) void refreshProjectsThreads();
      } catch (problem) {
        if (sequence !== projectReadSequence.current) return;
        if (revision === projectRevision.current) report(problem);
        if (
          refreshLists &&
          projectsLoadedRef.current &&
          !(problem instanceof HttpError && problem.authenticationRequired)
        )
          refreshProjectsThreads();
      }
    },
    [applyProjects, refreshProjectsThreads, report],
  );
  const settleMutation = useCallback(
    (id: string, result?: ThreadMutationResult, rollback = !result) => {
      const summary = projectStore.current.settleMutation(id, result);
      setProjectThreads(projectStore.current.snapshot);
      // Force the selected detail to re-project after removing its local mutation.
      setThread((previous) =>
        previous && summary?.id === previous.id
          ? { ...previous, archived: summary.archived, title: summary.title }
          : previous
            ? { ...previous }
            : previous,
      );
      const navigation = mutationNavigation.current.get(id);
      mutationNavigation.current.delete(id);
      if (
        rollback &&
        navigation &&
        navigation.projectId === projectRef.current &&
        navigation.revision === navigationRevision.current
      ) {
        if (navigation.left && !selectedRef.current)
          void selectThread(navigation.threadId, navigation.projectId);
        else if (selectedRef.current === navigation.threadId)
          changeArchiveView(navigation.archived);
      }
    },
    [selectThread, changeArchiveView],
  );

  const applyOperation = useCallback(
    (operation: Operation) => {
      const known = operationsRef.current.find(
        (entry) => entry.clientOperationId === operation.clientOperationId,
      );
      if (!known) return;
      // HTTP reads and live receipts can finish out of order. Terminal evidence is monotonic.
      if (
        known.operation &&
        (known.operation.updatedAt > operation.updatedAt ||
          (known.operation.execution?.ended && !operation.execution?.ended) ||
          (known.operation.reconciliation && !operation.reconciliation))
      )
        return;
      const turnId = (operation.result as { turnId?: string } | undefined)?.turnId;
      settleSubmission(
        operation.clientOperationId,
        operation.status === 'acknowledged'
          ? 'submitted'
          : operation.status === 'failed'
            ? 'failed'
            : operation.status === 'unknown'
              ? 'unknown'
              : 'submitting',
        turnId,
      );
      if (known.mutation && (isSettled(operation) || operation.reconciliation))
        settleMutation(
          operation.clientOperationId,
          operation.status === 'acknowledged'
            ? (operation.result as ThreadMutationResult)
            : undefined,
          operation.status === 'failed',
        );
      const draft = conversationDrafts.current.apply(operation);
      if (draft?.created) {
        settingsRef.current = {
          ...settingsRef.current,
          [`thread:${draft.created.id}`]: draft.created.settings,
        };
        setSettingsByScope(settingsRef.current);
      }
      if (draft?.sent) {
        const sent = draft.sent;
        setSentDrafts((previous) => ({ ...previous, [sent.key]: sent }));
      }
      if (known.lookupError)
        setError((previous) => (previous === known.lookupError?.message ? undefined : previous));
      track((previous) =>
        previous.map((entry) =>
          entry.clientOperationId === operation.clientOperationId
            ? {
                ...entry,
                status: operation.status,
                operation,
                error: operation.error ? errorMessage(operation.error) : undefined,
                lookupError: undefined,
                ...(operation.reconciliation ? { mutation: undefined } : {}),
              }
            : entry,
        ),
      );
      if (
        operation.status === 'failed' &&
        operation.error?.code !== 'THREAD_IN_USE' &&
        known.kind !== 'reconcile'
      ) {
        errorOperation.current = operation.clientOperationId;
        setErrorThreadId(operationThreadId(known));
        setError(
          (operation.error ? errorMessage(operation.error) : undefined) ??
            message('workspace:operation_failed_check_details'),
        );
        setErrorDetails(operation.error?.details);
      }
      if (operation.status === 'acknowledged') {
        // Recovery can finish before the initial project list restores the selected thread.
        // Keep the durable navigation intent until that selection can be checked safely.
        if (
          (!projectsLoadedRef.current || selectionRestoreRef.current !== undefined) &&
          known.navigateToResult &&
          (known.kind === 'create' || known.kind === 'fork')
        )
          return;
        if (known.kind === 'confirmCompatibility') void refreshSystem();
        if (known.kind === 'saveModelDefaults') {
          // Project drafts must not keep overriding a newer saved global preference.
          // Existing threads retain their explicit pending choices until they are applied.
          settingsRef.current = Object.fromEntries(
            Object.entries(settingsRef.current).map(([scope, settings]) => {
              if (!scope.startsWith('project:')) return [scope, settings];
              const next = { ...settings };
              delete next.model;
              delete next.reasoningEffort;
              return [scope, next];
            }),
          );
          setSettingsByScope(settingsRef.current);
          setRuntimeDefaultsRevision((revision) => revision + 1);
        }
        const result = operation.result as
          { threadId?: string; id?: string; thread?: { id?: string } } | undefined;
        const id =
          result?.threadId ??
          result?.thread?.id ??
          (known.kind === 'create' ? result?.id : undefined);
        if ((known.kind === 'create' || known.kind === 'fork') && id) {
          const project = known.projectId ?? (known.kind === 'create' ? known.target : undefined);
          if (project) void loadProjectThreads(project);
          if (
            known.navigateToResult &&
            (known.navigationSource?.projectId ?? project) === projectRef.current &&
            (known.kind === 'create' ||
              (known.navigationSource
                ? (known.navigationSource.threadId ?? undefined)
                : known.target) === selectedRef.current)
          ) {
            void selectThread(id, project);
          }
        }
      }
      if (isSettled(operation)) {
        if (operation.status !== 'failed' && errorOperation.current === operation.clientOperationId)
          setError(undefined);
        track((previous) =>
          previous.filter((entry) => entry.clientOperationId !== operation.clientOperationId),
        );
      }
    },
    [refreshSystem, selectThread, track, loadProjectThreads, settleMutation, settleSubmission],
  );

  useEffect(() => {
    // Restore pending thread projections after a reload, using real metadata as their baseline.
    for (const entry of operationsRef.current) {
      if (!entry.mutation) continue;
      void api
        .threadMetadata(entry.target)
        .then((detail) => {
          projectStore.current.seedMutation(entry.clientOperationId, toThreadSummary(detail));
          setProjectThreads(projectStore.current.snapshot);
        })
        .catch(report);
    }
  }, [report]);

  useEffect(() => {
    if (!projectsLoaded) return;
    for (const entry of operationsRef.current) {
      if (entry.operation?.status === 'acknowledged') applyOperation(entry.operation);
    }
  }, [projectsLoaded, restoringSelection, applyOperation]);

  const recordLookupError = useCallback(
    (entry: SavedOperation, problem: unknown) => {
      const lookupError = operationLookupError(problem);
      let applied = false;
      track((previous) =>
        previous.map((current) => {
          // A late failed read must not overwrite a receipt received through POST or WebSocket.
          if (
            current.clientOperationId !== entry.clientOperationId ||
            current.operation !== entry.operation
          )
            return current;
          applied = true;
          return { ...current, lookupError };
        }),
      );
      return applied ? lookupError.message : undefined;
    },
    [track],
  );
  const operationRefresh = useRef<Promise<void> | undefined>(undefined);
  const executionChecks = useRef(new Map<string, number>());
  const refreshOperations = useCallback(
    async (force = false): Promise<void> => {
      if (operationRefresh.current) {
        await operationRefresh.current;
        if (force) return refreshOperations(true);
        return;
      }
      const refreshing = (async () => {
        const threads = new Map<string, Promise<void>>();
        await Promise.all(
          operationsRef.current.map(async (entry) => {
            // A browser identity is saved before POST; it may not have reached the gateway yet.
            if (busyRef.current.has(`${entry.kind}:${entry.target}`)) return;
            try {
              let receipt = await api.operation(entry.clientOperationId);
              applyOperation(receipt);
              const threadId = operationThreadId({ ...entry, operation: receipt });
              if (
                threadId &&
                receipt.execution &&
                !receipt.execution.ended &&
                (force || Date.now() - (executionChecks.current.get(threadId) ?? 0) > 15_000)
              ) {
                let checking = threads.get(threadId);
                if (!checking) {
                  executionChecks.current.set(threadId, Date.now());
                  const stream = streamRef.current;
                  checking = stream?.isWatching(threadId)
                    ? Promise.resolve(stream.refresh(threadId))
                    : api.thread(threadId).then(() => undefined);
                  threads.set(threadId, checking);
                }
                // History may confirm the original execution ended. Fetch its updated receipt afterwards.
                await checking;
                receipt = await api.operation(entry.clientOperationId);
                applyOperation(receipt);
              }
            } catch (problem) {
              if (problem instanceof HttpError && problem.authenticationRequired) {
                report(problem);
                return;
              }
              recordLookupError(entry, problem);
            }
          }),
        );
      })();
      operationRefresh.current = refreshing;
      try {
        await refreshing;
      } finally {
        if (operationRefresh.current === refreshing) operationRefresh.current = undefined;
      }
    },
    [applyOperation, report, recordLookupError],
  );
  const refreshThread = useCallback(async (expectedId?: string) => {
    const id = selectedRef.current;
    const stream = streamRef.current;
    if (!id || !stream || (expectedId && id !== expectedId)) return;
    // A remembered session can be readable from cache before its metadata check recovers.
    stream.select(id, projectRef.current === UNASSIGNED_SCOPE ? null : projectRef.current);
    await stream.refresh(id);
  }, []);
  const loadThreads = useCallback(
    (cursor?: string) => loadProjectThreads(projectRef.current, cursor),
    [loadProjectThreads],
  );

  const notifications = useBrowserNotifications({
    navigationReady: projectsLoaded && !restoringSelection,
    projectName: (id) =>
      id === UNASSIGNED_SCOPE
        ? t('common:unassigned')
        : projectsRef.current.find((project) => project.id === id)?.name,
    openThread: (id, project, target) => {
      cancelResultNavigation();
      void selectThread(id, project);
      if (target) setNotificationTarget({ threadId: id, target });
    },
  });
  const notifyCompletion = notifications.notify;
  const notifyAttention = notifications.notifyAttention;

  useEffect(() => {
    let overviewRead: Promise<unknown> | undefined;
    const refreshOverview = () => {
      if (overviewRead) return;
      overviewRead = Promise.all([refreshProjects(true), refreshSystem()]).finally(() => {
        overviewRead = undefined;
      });
    };
    // Attach the overview stream before reading its initial data when possible.
    // HTTP still starts promptly if the socket cannot open.
    const startupFallback = setTimeout(refreshOverview, 150);
    const stream = new ThreadStream({
      connection: (state) => {
        setConnection(state);
        if (state === 'connected') {
          clearTimeout(startupFallback);
          refreshOverview();
          void refreshOperations(true);
        }
      },
      thread: updateThread,
      readError: (id, problem) => {
        if (problem instanceof HttpError) setThreadReadFailure({ id, status: problem.status });
        report(problem, id);
      },
      summary: updateSummary,
      completion: (completion) => {
        void notifyCompletion(completion);
      },
      attention: (request) => {
        void notifyAttention(request);
      },
      refresh: () => {
        refreshOverview();
        void refreshThread().then(() => refreshOperations(true));
      },
      system: (next) => {
        systemSnapshotGuard.current.runtimeEvent();
        setSystem(next);
      },
      projects: (next) => {
        projectRevision.current++;
        applyProjects(next);
      },
      operation: applyOperation,
      error: (message) => {
        setError(message);
        setErrorDetails(undefined);
      },
    });
    streamRef.current = stream;
    stream.start();
    if (selectedRef.current)
      stream.select(
        selectedRef.current,
        projectRef.current === UNASSIGNED_SCOPE ? null : projectRef.current,
      );
    return () => {
      clearTimeout(startupFallback);
      projectReadSequence.current++;
      stream.stop();
      streamRef.current = undefined;
    };
  }, [
    applyOperation,
    refreshSystem,
    updateThread,
    updateSummary,
    refreshProjects,
    applyProjects,
    notifyCompletion,
    notifyAttention,
    refreshThread,
    refreshOperations,
    report,
  ]);
  useEffect(() => {
    if (authRequired) {
      listBatch.current = undefined;
      for (const read of listReads.current.values()) read.abort();
      streamRef.current?.stop();
      setConnection('authenticationRequired');
    }
  }, [authRequired]);
  useEffect(() => {
    if (authRequired) return;
    void refreshOperations();
    const timer = setInterval(() => {
      void refreshOperations();
    }, 4_000);
    const systemTimer = setInterval(() => {
      void refreshSystem();
    }, 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(systemTimer);
    };
  }, [authRequired, refreshOperations, refreshSystem]);

  // A notLoaded notification can outlive the last receipt: recover the selected
  // projection even when there are no saved operations left to drive polling.
  useEffect(() => {
    if (authRequired || !thread?.managed || thread.status !== 'unknown') return;
    void refreshThread();
    const timer = setInterval(() => {
      void refreshThread();
    }, 15_000);
    return () => clearInterval(timer);
  }, [authRequired, thread?.id, thread?.managed, thread?.status, refreshThread]);

  const run = useCallback(
    async (
      kind: string,
      target: string,
      path: string,
      body: object = {},
      draft?: DraftSubmission,
      options?: { throwOnError: boolean },
    ) => {
      if (operationNeedsCompatibilityConfirmation(kind, system)) {
        setError(
          message('workspace:confirm_the_codex_version_compatibility_notice_before_starting'),
        );
        setErrorDetails(undefined);
        return undefined;
      }
      const key = `${kind}:${target}`;
      if (
        (kind === 'create' || kind === 'saveModelDefaults') &&
        [...busyRef.current].some((entry) => entry.startsWith('saveModelDefaults:'))
      ) {
        setError(message('common:model_defaults_are_being_saved_wait_before_proceeding'));
        return undefined;
      }
      if (busyRef.current.has(key)) return;
      if (
        (kind === 'archive' || kind === 'rename') &&
        operationsRef.current.some(
          (entry) =>
            (entry.kind === 'archive' || entry.kind === 'rename') && blocksTarget(entry, target),
        )
      )
        return;
      if (
        (kind === 'fork' || kind === 'create' || kind === 'send') &&
        operationsRef.current.some(
          (entry) => (kind !== 'fork' || entry.kind === 'fork') && blocksTarget(entry, target),
        )
      )
        return;
      busyRef.current.add(key);
      setBusy([...busyRef.current]);
      setError(undefined);
      setErrorThreadId(undefined);
      setErrorDetails(undefined);
      const clientOperationId =
        draft?.kind === 'create' && draft.creationId ? draft.creationId : crypto.randomUUID();
      if (draft) conversationDrafts.current.track(clientOperationId, draft);
      if (draft?.kind === 'send') {
        const message = body as import('../../shared/types').TaskMessage & {
          expectedTurnId?: string;
        };
        setLocalSubmissions((previous) => ({
          ...previous,
          [clientOperationId]: {
            id: clientOperationId,
            threadId: target,
            kind: kind === 'steer' ? 'steer' : 'start',
            ...(message.expectedTurnId ? { turnId: message.expectedTurnId } : {}),
            item: submittedUserMessage(clientOperationId, message),
            status: 'submitting',
            createdAt: Date.now(),
          },
        }));
      }
      const source =
        selectedThreadRef.current?.id === target
          ? toThreadSummary(selectedThreadRef.current)
          : Object.values(projectStore.current.snapshot)
              .flatMap((page) => page.data)
              .find((row) => row.id === target);
      const parent =
        kind === 'reconcile'
          ? operationsRef.current.find((entry) => entry.clientOperationId === target)
          : undefined;
      const actionOwner =
        kind === 'resolve' &&
        selectedThreadRef.current?.actions.some((action) => action.actionId === target)
          ? selectedThreadRef.current
          : undefined;
      const parentThreadId = parent && operationThreadId(parent);
      const parentOwner = parentThreadId
        ? selectedThreadRef.current?.id === parentThreadId
          ? selectedThreadRef.current
          : Object.values(projectStore.current.snapshot)
              .flatMap((page) => page.data)
              .find((row) => row.id === parentThreadId)
        : undefined;
      const owner = actionOwner ?? source ?? parentOwner;
      const context = owner
        ? { threadId: owner.id, projectId: owner.projectId, title: owner.title }
        : parent?.context;
      const errorOwner = context?.threadId ?? (parent && operationThreadId(parent));
      const mutation: ThreadMutation | undefined =
        kind === 'archive' &&
        source &&
        typeof (body as { archived?: boolean }).archived === 'boolean'
          ? { projectId: source.projectId, archived: (body as { archived: boolean }).archived }
          : kind === 'rename' && source && typeof (body as { name?: string }).name === 'string'
            ? { projectId: source.projectId, title: (body as { name: string }).name.trim() }
            : undefined;
      if (mutation) {
        projectStore.current.beginMutation(clientOperationId, target, mutation, source);
        setProjectThreads(projectStore.current.snapshot);
        if (selectedRef.current === target && mutation.archived !== undefined) {
          const archived = projectStore.current.archived;
          const left = mutation.archived;
          if (left) clearSelection();
          else changeArchiveView(false);
          mutationNavigation.current.set(clientOperationId, {
            projectId: scopeKey(mutation.projectId),
            threadId: target,
            revision: navigationRevision.current,
            archived,
            left,
          });
          setThread((previous) => (previous ? { ...previous } : previous));
        }
      }
      track((previous) => [
        ...previous,
        {
          clientOperationId,
          kind,
          target,
          createdAt: Date.now(),
          status: 'accepted',
          ...(context ? { context } : {}),
          ...(mutation ? { mutation } : {}),
          ...(kind === 'fork' || kind === 'create'
            ? {
                projectId:
                  kind === 'create'
                    ? target
                    : (projectStore.current.findProject(target) ?? projectRef.current),
                navigateToResult: true,
                ...(kind === 'fork'
                  ? {
                      navigationSource: {
                        projectId: projectRef.current,
                        threadId: selectedRef.current ?? null,
                      },
                    }
                  : {}),
              }
            : {}),
        },
      ]);
      try {
        const operation = await api.submit(path, { ...body, clientOperationId });
        applyOperation(operation);
        return operation;
      } catch (problem) {
        const definiteFailure =
          problem instanceof HttpError &&
          problem.status >= 400 &&
          problem.status < 500 &&
          problem.status !== 408 &&
          problem.problem.code !== 'RESULT_UNKNOWN';
        if (
          (!errorOwner || (definiteFailure && kind !== 'reconcile')) &&
          !(problem instanceof HttpError && problem.problem.code === 'THREAD_IN_USE')
        )
          report(problem, errorOwner, kind === 'reconcile' ? target : clientOperationId);
        if (kind === 'reconcile')
          track((previous) =>
            previous.map((entry) =>
              entry.clientOperationId === target
                ? { ...entry, recoveryError: readableError(problem) }
                : entry,
            ),
          );
        if (definiteFailure) {
          conversationDrafts.current.discard(clientOperationId);
          settleSubmission(clientOperationId, 'failed');
          if (mutation) settleMutation(clientOperationId);
          track((previous) =>
            previous.filter((entry) => entry.clientOperationId !== clientOperationId),
          );
          if (options?.throwOnError) throw problem;
          return undefined;
        }
        track((previous) =>
          previous.map((entry) =>
            entry.clientOperationId === clientOperationId
              ? { ...entry, status: 'unknown', error: readableError(problem) }
              : entry,
          ),
        );
        settleSubmission(clientOperationId, 'unknown');
        // Query the same operation identity. Never automatically resend an uncertain intent.
        const entry = operationsRef.current.find(
          (current) => current.clientOperationId === clientOperationId,
        );
        try {
          const recovered = await api.operation(clientOperationId);
          applyOperation(recovered);
          if (recovered.status === 'acknowledged') {
            setError((previous) => (previous === readableError(problem) ? undefined : previous));
            return recovered;
          }
        } catch (lookupProblem) {
          if (lookupProblem instanceof HttpError && lookupProblem.authenticationRequired)
            report(lookupProblem);
          else if (entry) {
            recordLookupError(entry, lookupProblem);
          }
        }
        if (options?.throwOnError)
          throw new HttpError(409, {
            code: 'RESULT_UNKNOWN',
            message: 'Operation result unconfirmed',
          });
        return undefined;
      } finally {
        busyRef.current.delete(key);
        setBusy([...busyRef.current]);
      }
    },
    [
      applyOperation,
      report,
      track,
      system,
      recordLookupError,
      clearSelection,
      changeArchiveView,
      settleMutation,
      settleSubmission,
    ],
  );

  const cancelResultNavigation = () => {
    setNotificationTarget(undefined);
    navigationRevision.current++;
    if (operationsRef.current.some((entry) => entry.navigateToResult))
      track((previous) =>
        previous.map((entry) =>
          entry.navigateToResult ? { ...entry, navigateToResult: false } : entry,
        ),
      );
  };

  const visibleThread = useMemo(
    () =>
      thread
        ? withPendingMessages(projectStore.current.project(thread), Object.values(localSubmissions))
        : undefined,
    [thread, projectThreads, operations, localSubmissions],
  );
  return {
    notificationTarget,
    clearNotificationTarget,
    projects,
    projectsLoaded,
    reorderProjects: async (projectIds: string[]) => {
      const revision = ++projectRevision.current;
      try {
        const { data } = await api.reorderProjects(projectIds);
        // A newer event (possibly from another tab) takes precedence over this response.
        if (revision === projectRevision.current) {
          projectRevision.current++;
          applyProjects(data);
        }
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        await refreshProjects();
        throw problem;
      }
    },
    openImportedProject: async (id: string) => {
      projectRevision.current++;
      await refreshProjects();
      if (projectsRef.current.some((entry) => entry.id === id)) {
        cancelResultNavigation();
        selectProject(id);
      }
    },
    addProject: async (input: { path: string; name?: string }) => {
      projectRevision.current++;
      try {
        const added = await api.addProject(input);
        await refreshProjects();
        if (projectsRef.current.some((entry) => entry.id === added.id)) {
          cancelResultNavigation();
          selectProject(added.id);
        }
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    renameProject: async (id: string, name: string) => {
      projectRevision.current++;
      try {
        await api.renameProject(id, name);
        await refreshProjects();
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    removeProject: async (id: string) => {
      projectRevision.current++;
      try {
        await api.removeProject(id);
        await refreshProjects();
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    projectId,
    draftKey: conversationDrafts.current.key(projectId, selectedId),
    draftCreationId: conversationDrafts.current.creationId(
      conversationDrafts.current.key(projectId, selectedId),
    ),
    sentDrafts,
    restoringSelection,
    firstMessages,
    sendFirstMessage: async (
      text: string,
      images?: string[],
      taskKind?: 'init',
      skills?: import('../../shared/skills').SkillReference[],
      files?: import('../../shared/file-references').FileReference[],
    ) => {
      const project = projectRef.current;
      if (selectedRef.current || firstMessagesRef.current.has(project)) return false;
      const key = conversationDrafts.current.key(project);
      const settings = getProjectSettings(project);
      firstMessagesRef.current.add(project);
      setFirstMessages([...firstMessagesRef.current]);
      try {
        const created = await run(
          'create',
          project,
          `${scopeApi(project)}/threads`,
          { settings },
          {
            kind: 'create',
            key,
            projectId: project,
            settings,
            creationId: conversationDrafts.current.creationId(key),
          },
        );
        const id = (created?.result as { threadId?: string } | undefined)?.threadId;
        if (created?.status !== 'acknowledged' || !id) return false;
        const sent = await run(
          'send',
          id,
          `/api/threads/${encodeURIComponent(id)}/turns`,
          { text, images, skills, files, settings, ...(taskKind ? { taskKind } : {}) },
          { kind: 'send', key, text, images, skills, files },
        );
        return sent?.status === 'acknowledged';
      } finally {
        firstMessagesRef.current.delete(project);
        setFirstMessages([...firstMessagesRef.current]);
      }
    },
    openDraft: () => {
      cancelResultNavigation();
      selectProject(projectRef.current);
      return conversationDrafts.current.key(projectRef.current);
    },
    setProjectId: (id: string) => {
      cancelResultNavigation();
      selectProject(id);
    },
    archiveView,
    setArchiveView: (archived: boolean) => {
      if (archived === projectStore.current.archived) return;
      cancelResultNavigation();
      clearSelection();
      changeArchiveView(archived);
    },
    archiveThread: async (id: string, archived: boolean) => {
      const revision = navigationRevision.current;
      const operation = await run('archive', id, `/api/threads/${encodeURIComponent(id)}/archive`, {
        archived,
      });
      // Overview events update just this row, preserving loaded pages and scroll.
      // Only reconcile the original detail if the user has not navigated elsewhere.
      if (
        operation?.status === 'acknowledged' &&
        selectedRef.current === id &&
        navigationRevision.current === revision
      )
        await refreshThread();
    },
    projectThreads,
    cacheScope,
    threads: projectThreads[projectId]?.data ?? [],
    nextCursor: projectThreads[projectId]?.nextCursor ?? null,
    thread: visibleThread,
    selectedId,
    threadReadFailure,
    selectThread: (id: string, owningProjectId?: string) => {
      cancelResultNavigation();
      return selectThread(id, owningProjectId);
    },
    system,
    connection,
    error: !errorThreadId || errorThreadId === selectedId ? error : undefined,
    errorDetails,
    clearError: () => {
      setError(undefined);
      setErrorDetails(undefined);
    },
    authRequired: authRequired || connection === 'authenticationRequired',
    busy,
    loadingThreads: projectThreads[projectId]?.loading ?? false,
    operations,
    settings: settingsByScope[selectedId ? `thread:${selectedId}` : `project:${projectId}`] ?? {},
    setSettings,
    getProjectSettings,
    updateLiveSettings: (settings: import('../../shared/types').LiveSettings) => {
      const target = selectedThreadRef.current;
      const turn = target?.turns.at(-1);
      if (!target?.managed || !turn) return;
      const previous = liveSettingsQueue.current.get(target.id) ?? Promise.resolve();
      const writing = previous
        .catch(() => {})
        .then(() =>
          run(
            'liveSettings',
            target.id,
            `/api/threads/${encodeURIComponent(target.id)}/live-settings`,
            { expectedTurnId: turn.id, settings },
          ),
        );
      liveSettingsQueue.current.set(target.id, writing);
      void writing.finally(() => {
        if (liveSettingsQueue.current.get(target.id) === writing)
          liveSettingsQueue.current.delete(target.id);
      });
    },
    runtimeDefaultsRevision,
    savingModelDefaults: busy.some((entry) => entry.startsWith('saveModelDefaults:')),
    saveModelDefaults: async (
      settings: ModelDefaults,
    ): Promise<ModelDefaultsResult | undefined> => {
      const project = projectRef.current;
      const operation = await run(
        'saveModelDefaults',
        `model-defaults:${project}`,
        `${scopeApi(project)}/model-defaults`,
        { settings },
      );
      return operation?.status === 'acknowledged'
        ? (operation.result as ModelDefaultsResult)
        : undefined;
    },
    run,
    loadThreads,
    loadProjectThreads,
    refreshProjects,
    refreshThread,
    refreshSystem,
    refreshOperations,
    discardMissingOperation: (id: string) => {
      const entry = operationsRef.current.find((current) => current.clientOperationId === id);
      if (
        !entry ||
        !canDiscardMissingOperation(entry) ||
        busyRef.current.has(`${entry.kind}:${entry.target}`)
      )
        return;
      conversationDrafts.current.discard(id);
      if (entry.mutation) settleMutation(id, undefined, false);
      track((previous) => previous.filter((current) => current.clientOperationId !== id));
      setError((previous) => (previous === entry.lookupError?.message ? undefined : previous));
    },
    retryConnection: () => streamRef.current?.retry(),
    notifications,
  };
}

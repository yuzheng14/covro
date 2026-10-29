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
import { api, HttpError } from '../lib/api';
import { pendingSettings } from '../lib/settings';
import { readSessionSettings, saveSessionSettings } from '../lib/session-settings';
import {
  blocksTarget,
  canDiscardMissingOperation,
  isSettled,
  operationLookupError,
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
  const [projectThreads, setProjectThreads] = useState(projectStore.current.snapshot);
  const [thread, setThread] = useState<ThreadView>();
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

  const report = useCallback((problem: unknown) => {
    setError(readableError(problem));
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
      if (id !== UNASSIGNED_SCOPE && !projectsRef.current.some((project) => project.id === id))
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
        if (page && store.finishRead(read, page)) setProjectThreads(projectStore.current.snapshot);
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
  const refreshProjectsThreads = useCallback(
    () =>
      Promise.all([
        loadProjectThreads(UNASSIGNED_SCOPE),
        ...projectsRef.current
          .filter((entry) => entry.available)
          .map((entry) => loadProjectThreads(entry.id)),
      ]),
    [loadProjectThreads],
  );
  const changeArchiveView = useCallback(
    (archived: boolean) => {
      if (!projectStore.current.setArchived(archived)) return;
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
        const cached = streamRef.current?.cache.get(summary.id)?.data;
        if (
          summary.id !== selectedRef.current &&
          cached &&
          Boolean(cached.archived) !== Boolean(summary.archived)
        ) {
          // An unselected cache can miss the archive detail event, then return to
          // the same visible state after restore. Never replay that obsolete visit.
          streamRef.current?.cache.invalidateDetail(summary.id);
        }
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
          loaded = restoring ? await api.threadMetadata(id) : await api.thread(id);
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
      const cached = streamRef.current?.cache.get(id)?.data;
      // An unselected detail cache may predate an archive/restore overview event.
      const initial =
        cached &&
        scopeKey(cached.projectId) === project &&
        Boolean(cached.archived) === projectStore.current.archived
          ? cached
          : loaded;
      selectedThreadRef.current = initial;
      setThread(initial);
      // Do not replay pre-archive lifecycle events when explicitly opening archived
      // history (or a restored conversation). The overview already knows its new state.
      if (cached && initial !== cached) streamRef.current?.cache.invalidateDetail(id);
      streamRef.current?.select(id);
      try {
        localStorage.setItem(`codex-web.selected:${project}`, id);
      } catch {
        /* Preferences are optional. */
      }
      try {
        loaded ??= await api.thread(id);
        if (
          selectedRef.current !== id ||
          projectRef.current !== project ||
          navigationRevision.current !== revision ||
          detailReadSequence.current !== read
        )
          return;
        const latest = streamRef.current?.cache.get(id)?.data;
        updateThread(latest && latest !== cached ? latest : loaded);
      } catch (problem) {
        if (
          selectedRef.current === id &&
          projectRef.current === project &&
          navigationRevision.current === revision &&
          detailReadSequence.current === read
        ) {
          if (problem instanceof HttpError) setThreadReadFailure({ id, status: problem.status });
          report(problem);
        }
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
    (data: Project[]) => {
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
          streamRef.current?.cache.removeProject(project.id);
        }
        setProjectThreads(projectStore.current.snapshot);
      }
      const added = data.filter(
        (entry) =>
          entry.available && !projectsRef.current.some((project) => project.id === entry.id),
      );
      projectsRef.current = data;
      setProjects(data);
      const preferred = projectRef.current;
      if (!projectsLoadedRef.current || !ids.has(preferred)) {
        selectProject(
          ids.has(preferred)
            ? preferred
            : (data.find((entry) => entry.available)?.id ?? data[0]?.id ?? UNASSIGNED_SCOPE),
          !projectsLoadedRef.current,
        );
      }
      if (!projectsLoadedRef.current) void loadProjectThreads(UNASSIGNED_SCOPE);
      projectsLoadedRef.current = true;
      setProjectsLoaded(true);
      for (const project of added) void loadProjectThreads(project.id);
    },
    [loadProjectThreads, selectProject],
  );
  const refreshProjects = useCallback(async () => {
    const sequence = ++projectReadSequence.current;
    const revision = projectRevision.current;
    try {
      const { data } = await api.projects();
      if (sequence === projectReadSequence.current && revision === projectRevision.current)
        applyProjects(data);
    } catch (problem) {
      if (sequence === projectReadSequence.current && revision === projectRevision.current)
        report(problem);
    }
  }, [applyProjects, report]);
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
      if (operation.status === 'failed' && operation.error?.code !== 'THREAD_IN_USE') {
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
      if (isSettled(operation))
        track((previous) =>
          previous.filter((entry) => entry.clientOperationId !== operation.clientOperationId),
        );
    },
    [refreshSystem, selectThread, track, loadProjectThreads, settleMutation],
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
  const refreshOperations = useCallback(
    async (reportErrors = false) => {
      const failures: string[] = [];
      await Promise.all(
        operationsRef.current.map(async (entry) => {
          // A browser identity is saved before POST; it may not have reached the gateway yet.
          if (busyRef.current.has(`${entry.kind}:${entry.target}`)) return;
          try {
            applyOperation(await api.operation(entry.clientOperationId));
          } catch (problem) {
            if (problem instanceof HttpError && problem.authenticationRequired) {
              report(problem);
              return;
            }
            const message = recordLookupError(entry, problem);
            if (message) failures.push(message);
          }
        }),
      );
      const currentFailures = failures.filter((message) =>
        operationsRef.current.some((entry) => entry.lookupError?.message === message),
      );
      if (reportErrors && currentFailures.length)
        report(new Error([...new Set(currentFailures)].join('\n')));
    },
    [applyOperation, report, recordLookupError],
  );
  const refreshThread = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    // A remembered session can be readable from cache before its metadata check recovers.
    streamRef.current?.select(id);
    const revision = navigationRevision.current;
    const read = ++detailReadSequence.current;
    try {
      const cached = streamRef.current?.cache.get(id)?.data;
      const loaded = await api.thread(id);
      if (revision !== navigationRevision.current || detailReadSequence.current !== read) return;
      const latest = streamRef.current?.cache.get(id)?.data;
      updateThread(latest && latest !== cached ? latest : loaded);
    } catch (problem) {
      if (revision === navigationRevision.current && detailReadSequence.current === read) {
        if (problem instanceof HttpError) setThreadReadFailure({ id, status: problem.status });
        report(problem);
      }
    }
  }, [report, updateThread]);
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
    void refreshProjects();
    void refreshSystem();
    return () => {
      projectReadSequence.current++;
    };
  }, [refreshSystem, refreshProjects]);
  useEffect(() => {
    const stream = new ThreadStream({
      connection: (state) => {
        setConnection(state);
        if (state === 'connected') {
          void refreshSystem();
          void refreshProjects().then(refreshProjectsThreads);
        }
      },
      thread: updateThread,
      summary: updateSummary,
      completion: (completion) => {
        void notifyCompletion(completion);
      },
      attention: (request) => {
        void notifyAttention(request);
      },
      refresh: () => {
        void refreshProjects().then(refreshProjectsThreads);
        void refreshThread();
        void refreshOperations();
        void refreshSystem();
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
    if (selectedRef.current) stream.select(selectedRef.current);
    return () => {
      stream.stop();
      streamRef.current = undefined;
    };
  }, [
    applyOperation,
    refreshSystem,
    updateThread,
    updateSummary,
    refreshProjectsThreads,
    refreshProjects,
    applyProjects,
    notifyCompletion,
    notifyAttention,
    refreshThread,
    refreshOperations,
  ]);
  useEffect(() => {
    if (authRequired) {
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

  const run = useCallback(
    async (
      kind: string,
      target: string,
      path: string,
      body: object = {},
      draft?: DraftSubmission,
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
      setErrorDetails(undefined);
      const clientOperationId =
        draft?.kind === 'create' && draft.creationId ? draft.creationId : crypto.randomUUID();
      if (draft) conversationDrafts.current.track(clientOperationId, draft);
      const source =
        selectedThreadRef.current?.id === target
          ? toThreadSummary(selectedThreadRef.current)
          : Object.values(projectStore.current.snapshot)
              .flatMap((page) => page.data)
              .find((row) => row.id === target);
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
        if (!(problem instanceof HttpError && problem.problem.code === 'THREAD_IN_USE'))
          report(problem);
        if (
          problem instanceof HttpError &&
          problem.status >= 400 &&
          problem.status < 500 &&
          problem.status !== 408 &&
          problem.problem.code !== 'RESULT_UNKNOWN'
        ) {
          conversationDrafts.current.discard(clientOperationId);
          if (mutation) settleMutation(clientOperationId);
          track((previous) =>
            previous.filter((entry) => entry.clientOperationId !== clientOperationId),
          );
          return undefined;
        }
        track((previous) =>
          previous.map((entry) =>
            entry.clientOperationId === clientOperationId
              ? { ...entry, status: 'unknown', error: readableError(problem) }
              : entry,
          ),
        );
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
            const message = recordLookupError(entry, lookupProblem);
            if (message) report(new Error(message));
          }
        }
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
    () => (thread ? projectStore.current.project(thread) : undefined),
    [thread, projectThreads, operations],
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
          { text, images, skills, settings, ...(taskKind ? { taskKind } : {}) },
          { kind: 'send', key, text, images, skills },
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
    error,
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
    refreshProjectsThreads,
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

import { UNASSIGNED_SCOPE } from '../../shared/workspace-scope';
import { displayMessage } from '../i18n/messages';
import { t, currentLocale } from '../i18n';
import { useState } from 'react';
import { ArrowDownUp, ArrowUpCircle, Server } from 'lucide-react';
import type { Project, ThreadSummary, SystemInfo } from '../../shared/types';
import type { ProjectThreads } from '../lib/project-threads';
import { cn } from '../lib/utils';
import { ControlHint } from './ControlHint';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';
import { ThreadLink } from './ThreadLink';
import { ThreadListNavigation } from './ThreadListNavigation';
import { ProjectOrderList } from './ProjectOrderList';
import { SidebarSettings } from './SidebarSettings';
import { newSessionShortcut } from '../hooks/useNewSessionShortcut';

interface Props {
  system?: SystemInfo;
  archiveView: boolean;
  onArchiveView: (archived: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  archiveDisabledReason: (thread: ThreadSummary) => string | undefined;
  onFork: (thread: ThreadSummary) => void;
  forkDisabledReason: (thread: ThreadSummary) => string | undefined;
  forking: (id: string) => boolean;
  projects: Project[];
  projectsLoaded: boolean;
  projectId: string;
  onProject: (id: string) => void;
  projectThreads: Record<string, ProjectThreads>;
  selectedId?: string;
  isUnreadCompletion: (thread: ThreadSummary) => boolean;
  onThread: (id: string, projectId: string) => void;
  onMore: (projectId: string, cursor: string) => void;
  onRetry: (projectId: string) => void;
  onRefresh: () => void;
  onCreate: (projectId: string) => void;
  onAddProject: () => void;
  onManageProject: (project: Project) => void;
  canManageProjects: boolean;
  onReorderProjects: (projectIds: string[]) => Promise<void>;
  creating: (projectId: string) => boolean;
  canCreate: (projectId: string) => boolean;
  offline: boolean;
  open: boolean;
  onClose: () => void;
  onNotificationSettings: () => void;
  onGatewaySettings: () => void;
  onBackups?: () => void;
  notificationStatus: string;
  onUpdates: () => void;
  appVersion?: string;
  updateAvailable: boolean;
  updating: boolean;
}

export function Sidebar(props: Props) {
  const shortcut = newSessionShortcut(navigator.platform);
  const [search, setSearch] = useState('');
  const [ordering, setOrdering] = useState(false);
  const query = search.trim().toLocaleLowerCase();
  const scopes = [
    {
      id: UNASSIGNED_SCOPE,
      name: t('common:unassigned'),
      rootPath: '',
      available: true,
      error: undefined,
      project: undefined as Project | undefined,
    },
    ...props.projects.map((project) => ({ ...project, project })),
  ];
  const groups = scopes.flatMap((project) => {
    const state = props.projectThreads[project.id];
    const matchesProject = `${project.name} ${project.rootPath}`
      .toLocaleLowerCase()
      .includes(query);
    const threads = (state?.data ?? []).filter(
      (thread) => matchesProject || thread.title.toLocaleLowerCase().includes(query),
    );
    return matchesProject || threads.length > 0 ? [{ project, state, threads }] : [];
  });
  return (
    <>
      {props.open && (
        <button
          className="sidebar-backdrop"
          aria-label={t('sidebar:close_session_navigation')}
          onClick={props.onClose}
        />
      )}
      <aside
        className={cn('sidebar', props.open && 'sidebar-open')}
        aria-label={t('sidebar:projects_and_sessions')}
      >
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-mark">
              <img src="/covro.svg" alt="" width="28" height="28" />
            </div>
            <ControlHint
              asChild
              side="bottom"
              align="start"
              content={`Covro ${props.appVersion ?? ''} · ${props.updating ? t('sidebar:updating') : props.updateAvailable ? t('sidebar:update_available') : t('sidebar:version_and_updates')}`}
            >
              <button
                type="button"
                className="brand-name covro-brand-button"
                aria-label={t('common:covro_updates')}
                data-update-available={props.updateAvailable || props.updating}
                onClick={props.onUpdates}
              >
                Covro <ArrowUpCircle size={13} aria-hidden="true" />
              </button>
            </ControlHint>
            <Button
              className="add-project"
              variant="secondary"
              size="sm"
              onClick={props.onAddProject}
              disabled={!props.canManageProjects}
            >
              <Icon name="plus" size={15} />
              {t('common:add_project')}
            </Button>
            <Button
              className="mobile-only"
              variant="ghost"
              size="icon"
              aria-label={t('sidebar:close_navigation')}
              onClick={props.onClose}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div className="project-search">
            <label className="sr-only" htmlFor="project-search">
              {t('sidebar:projects_and_sessions')}
            </label>
            <input
              id="project-search"
              type="search"
              aria-label={t('sidebar:search_projects_and_loaded_sessions')}
              aria-describedby="sidebar-search-summary"
              placeholder={t('sidebar:search_projects_and_loaded_sessions')}
              value={search}
              disabled={ordering}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span id="sidebar-search-summary" className="sr-only" role="status">
              {query
                ? t('sidebar:search_results_groups', { v0: groups.length, count: groups.length })
                : t('sidebar:all_sessions_projects', {
                    v0: props.projects.length,
                    count: props.projects.length,
                  })}
            </span>
          </div>
          <div className="sidebar-toolbar">
            <div
              className="archive-switch"
              role="group"
              aria-label={t('sidebar:session_list_scope')}
            >
              <Button
                variant={props.archiveView ? 'ghost' : 'secondary'}
                size="sm"
                aria-pressed={!props.archiveView}
                onClick={() => props.onArchiveView(false)}
              >
                {t('common:sessions')}
              </Button>
              <Button
                variant={props.archiveView ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={props.archiveView}
                onClick={() => props.onArchiveView(true)}
              >
                <Icon name="archive" size={14} />
                {t('sidebar:archived_sessions')}
              </Button>
            </div>
            <ControlHint content={t('sidebar:reorder_projects')}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sidebar:reorder_projects')}
                aria-pressed={ordering}
                disabled={ordering || !props.canManageProjects || props.projects.length < 2}
                onClick={() => {
                  setSearch('');
                  setOrdering(true);
                }}
              >
                <ArrowDownUp size={14} aria-hidden="true" />
              </Button>
            </ControlHint>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sidebar:refresh_session_list')}
              onClick={props.onRefresh}
              disabled={!props.projectsLoaded}
            >
              <Icon name="refresh" size={14} />
            </Button>
          </div>
        </div>
        <ThreadListNavigation
          locale={currentLocale()}
          context={`${props.archiveView}:${query}:${ordering}`}
          rows={props.projectThreads}
        >
          {ordering && (
            <ProjectOrderList
              projects={props.projects}
              disabled={!props.canManageProjects}
              onReorder={props.onReorderProjects}
              onClose={() => setOrdering(false)}
            />
          )}
          {(ordering ? [] : groups).map(({ project, state, threads }) => {
            const activeCount = (state?.data ?? []).filter((entry) =>
              isActive(entry.status),
            ).length;
            const createLabel = props.creating(project.id)
              ? t('sidebar:creating')
              : project.project
                ? t('sidebar:new_session')
                : t('sidebar:new_unassigned_session');
            const shortcutTarget = props.projectId === project.id && !props.creating(project.id);
            return (
              <section
                key={project.id}
                className="project-group"
                aria-label={project.name}
                data-project-id={project.project?.id}
                data-scope-id={project.id}
              >
                <h2 className="project-heading">
                  <ControlHint asChild content={project.name}>
                    <button
                      className="project-link"
                      onClick={() => props.onProject(project.id)}
                      aria-current={props.projectId === project.id ? 'true' : undefined}
                    >
                      <Icon name={project.project ? 'folder' : 'code'} size={16} />
                      <span>{project.name}</span>
                      {activeCount > 0 && (
                        <span
                          className="project-activity"
                          aria-label={t('sidebar:active_sessions', {
                            count: activeCount,
                            v0: activeCount,
                          })}
                        >
                          {activeCount}
                        </span>
                      )}
                    </button>
                  </ControlHint>
                  <ControlHint
                    content={shortcutTarget ? `${createLabel} · ${shortcut.label}` : createLabel}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={createLabel}
                      aria-keyshortcuts={shortcutTarget ? shortcut.aria : undefined}
                      onClick={() => props.onCreate(project.id)}
                      disabled={!props.canCreate(project.id) || props.creating(project.id)}
                    >
                      <Icon name={props.creating(project.id) ? 'loader' : 'plus'} size={15} />
                    </Button>
                  </ControlHint>
                  {project.project && (
                    <ControlHint content={t('common:manage_project')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('sidebar:manage_project', { v0: project.name })}
                        onClick={() => props.onManageProject(project.project!)}
                        disabled={!props.canManageProjects}
                      >
                        <Icon name="settings" size={15} />
                      </Button>
                    </ControlHint>
                  )}
                </h2>
                {!project.available && (
                  <p className="inline-error project-error" role="status">
                    {t('common:project_directory_unavailable')}
                  </p>
                )}
                <div className="thread-list">
                  {threads.map((entry) => (
                    <ThreadLink
                      key={entry.id}
                      thread={entry}
                      selected={entry.id === props.selectedId}
                      unreadCompletion={props.isUnreadCompletion(entry)}
                      offline={props.offline}
                      onArchive={() => props.onArchive(entry.id, !entry.archived)}
                      archiveDisabledReason={props.archiveDisabledReason(entry)}
                      onFork={() => props.onFork(entry)}
                      forkDisabledReason={props.forkDisabledReason(entry)}
                      forking={props.forking(entry.id)}
                      onSelect={() => {
                        props.onThread(entry.id, project.id);
                        props.onClose();
                      }}
                    />
                  ))}
                  {project.available &&
                    !state?.loading &&
                    !state?.error &&
                    threads.length === 0 && (
                      <p className="sidebar-empty">
                        {query
                          ? t('sidebar:no_matches_among_loaded_sessions')
                          : props.archiveView
                            ? t('sidebar:no_archived_sessions_yet')
                            : t('sidebar:no_sessions_yet_create_one_to_get_started')}
                      </p>
                    )}
                  {state && (
                    <div className="thread-pagination" aria-live="polite" aria-busy={state.loading}>
                      {Boolean(state.unverified?.length) && (
                        <p className="sidebar-pagination-status" role="status">
                          {state.error
                            ? t('sidebar:local_list_sync_failed_browsing_is_still_available')
                            : state.loading
                              ? t('sidebar:showing_local_list_syncing_in_background')
                              : t('sidebar:some_local_entries_are_not_synced_load_more')}
                        </p>
                      )}
                      {state.loading || state.error || state.nextCursor ? (
                        <ControlHint content={displayMessage(state.error)}>
                          <Button
                            variant="ghost"
                            className={cn('load-more', state.error && 'load-more-error')}
                            size="sm"
                            disabled={state.loading}
                            aria-describedby={
                              state.error ? `thread-pagination-error-${project.id}` : undefined
                            }
                            onClick={() => {
                              if (state.error) props.onRetry(project.id);
                              else if (state.nextCursor) props.onMore(project.id, state.nextCursor);
                            }}
                          >
                            {state.loading
                              ? state.appending
                                ? t('sidebar:loading_more_sessions')
                                : t('sidebar:syncing_sessions')
                              : state.error
                                ? t('sidebar:load_failed_retry')
                                : t('sidebar:load_more_sessions')}
                          </Button>
                        </ControlHint>
                      ) : state.loaded && state.data.length > 0 && !query ? (
                        <p className="sidebar-pagination-status">
                          {t('sidebar:all_sessions_loaded')}
                        </p>
                      ) : null}
                      {state.error && (
                        <span className="sr-only" id={`thread-pagination-error-${project.id}`}>
                          {displayMessage(state.error)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
          {!ordering && groups.length === 0 && (
            <p className="sidebar-empty">
              {query
                ? t('sidebar:no_matching_projects_or_loaded_sessions')
                : props.projectsLoaded
                  ? t('sidebar:no_sessions_yet')
                  : t('sidebar:loading_projects')}
            </p>
          )}
        </ThreadListNavigation>
        <div className="sidebar-footer">
          <SidebarSettings
            system={props.system}
            offline={props.offline}
            notificationStatus={props.notificationStatus}
            onNotificationSettings={props.onNotificationSettings}
            onGatewaySettings={props.onGatewaySettings}
            onBackups={props.onBackups}
          />
          <span className="sidebar-execution-location">
            <Server size={14} aria-hidden="true" />
            {t('sidebar:runs_on_server')}
          </span>
        </div>
      </aside>
    </>
  );
}

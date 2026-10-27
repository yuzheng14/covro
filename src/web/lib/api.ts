import { errorMessage } from './error-message';
import { message, displayMessage } from '../i18n/messages';
import { localPreviewUrl } from './local-files';
import { scopeApi } from '../../shared/workspace-scope';
import type {
  ApiError,
  AttentionRequest,
  TextFile,
  RuntimeSettings,
  Operation,
  Project,
  ProjectClone,
  CloneProjectInput,
  SystemInfo,
  ThreadSummaryPage,
  ThreadView,
} from '../../shared/types';
import type {
  GatewayConfig,
  GatewayConfigSnapshot,
  GatewayConfigImport,
} from '../../shared/gateway-config';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: ApiError,
  ) {
    super(displayMessage(errorMessage(problem)));
    this.name = 'HttpError';
  }
  get authenticationRequired() {
    return this.status === 401 || this.status === 403 || this.problem.code === 'AUTH_REQUIRED';
  }
}

export async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(35_000),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(response.status === 200 ? 401 : response.status, {
      code: 'AUTH_REQUIRED',
      message: message('errors:your_login_expired_or_the_gateway_returned_a'),
    });
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const problem =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error: ApiError }).error
        : undefined;
    throw new HttpError(
      response.status,
      problem ?? {
        code: 'HTTP_ERROR',
        message: message('errors:request_failed', { v0: response.status }),
      },
    );
  }
  return data as T;
}

export const api = {
  projectPath: (path: string, directory?: string) =>
    request<{ workDir?: string; path: string }>(
      `/api/project-path?${new URLSearchParams({ path, ...(directory === undefined ? {} : { directory }) })}`,
    ),
  gatewayConfig: () => request<GatewayConfigSnapshot>('/api/config'),
  saveGatewayConfig: (revision: string, config: GatewayConfig) =>
    request<GatewayConfigSnapshot>('/api/config', { revision, config }),
  importGatewayConfig: (config: unknown) =>
    request<GatewayConfigImport>('/api/config/import', { config }),
  exportGatewayConfig: () => request<GatewayConfig>('/api/config/export'),
  historyCacheContext: () => request<{ scope: string }>('/api/history-cache-context'),
  system: () => request<SystemInfo>('/api/system'),
  accountUsage: () =>
    request<import('../../shared/account-usage').AccountUsage>('/api/account/usage'),
  runtimeSettings: (projectId: string) =>
    request<RuntimeSettings>(`${scopeApi(projectId)}/runtime-settings`),
  projects: () => request<{ data: Project[] }>('/api/projects'),
  reorderProjects: (projectIds: string[]) =>
    request<{ data: Project[] }>('/api/projects/reorder', { projectIds }),
  addProject: (input: { path: string; name?: string }) => request<Project>('/api/projects', input),
  cloneProject: (input: CloneProjectInput) => request<ProjectClone>('/api/project-clones', input),
  projectClone: (id: string) =>
    request<ProjectClone>(`/api/project-clones/${encodeURIComponent(id)}`),
  cancelProjectClone: (id: string) =>
    request<ProjectClone>(`/api/project-clones/${encodeURIComponent(id)}/cancel`, {}),
  registerProjectClone: (id: string) =>
    request<ProjectClone>(`/api/project-clones/${encodeURIComponent(id)}/register`, {}),
  renameProject: (id: string, name: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}/rename`, { name }),
  removeProject: (id: string) =>
    request<{ removed: true }>(`/api/projects/${encodeURIComponent(id)}/remove`, {}),
  threads: (projectId: string, cursor?: string, archived = false, signal?: AbortSignal) =>
    request<ThreadSummaryPage>(
      `${scopeApi(projectId)}/threads${archived ? '?archived=true' : ''}${cursor ? `${archived ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined,
      signal,
    ),
  thread: (threadId: string, signal?: AbortSignal) =>
    request<ThreadView>(`/api/threads/${encodeURIComponent(threadId)}`, undefined, signal),
  threadSnapshot: (threadId: string, signal?: AbortSignal) =>
    request<{ data: ThreadView; cursor: import('../../shared/types').Cursor }>(
      `/api/threads/${encodeURIComponent(threadId)}/snapshot`,
      undefined,
      signal,
    ),
  threadAttention: (threadId: string) =>
    request<AttentionRequest[]>(`/api/threads/${encodeURIComponent(threadId)}/attention`),
  threadHistory: (threadId: string, cursor: string, signal: AbortSignal) =>
    request<ThreadView>(
      `/api/threads/${encodeURIComponent(threadId)}/history?${new URLSearchParams({ cursor })}`,
      undefined,
      signal,
    ),
  threadMetadata: (threadId: string) =>
    request<ThreadView>(`/api/threads/${encodeURIComponent(threadId)}/metadata`),
  previewFile: (threadId: string, path: string, signal: AbortSignal) =>
    request<TextFile>(localPreviewUrl(threadId, path), undefined, signal),
  operation: (id: string) => request<Operation>(`/api/operations/${encodeURIComponent(id)}`),
  submit: (path: string, body: object) => request<Operation>(path, body),
};

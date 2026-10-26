import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { request } from '../lib/api';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';

export function GithubRepositoryLink({
  projectId,
  threadId,
}: {
  projectId?: string;
  threadId?: string;
}) {
  const path = threadId
    ? `/api/threads/${encodeURIComponent(threadId)}/github-repository`
    : projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/github-repository`
      : undefined;
  const [repository, setRepository] = useState<{ path: string; url: string | null }>();
  useEffect(() => {
    if (!path) return;
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      void request<{ url: string | null }>(path, undefined, current.signal)
        .then(({ url }) => {
          if (!current.signal.aborted) setRepository({ path, url });
        })
        .catch(() => {
          if (!current.signal.aborted) setRepository({ path, url: null });
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [path]);
  const url = repository?.path === path ? repository?.url : null;
  if (!url) return null;
  return (
    <ControlHint asChild content={t('workspace:open_github_repository')}>
      <a
        className="button button-ghost button-icon"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('workspace:open_github_repository')}
      >
        <Icon name="github" size={18} />
      </a>
    </ControlHint>
  );
}

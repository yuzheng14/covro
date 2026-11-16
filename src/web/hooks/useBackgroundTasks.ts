import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectClone } from '../../shared/types';
import { api } from '../lib/api';
import { cloneRunning } from '../lib/project-clone-labels';

/** Server snapshots own tasks. No browser storage, replay event or dialog can start work. */
export function useBackgroundTasks(enabled: boolean) {
  const [jobs, setJobs] = useState<ProjectClone[]>([]);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<ProjectClone>();
  const known = useRef(new Map<string, ProjectClone['status']>());
  const revision = useRef(0);
  const accept = useCallback((job: ProjectClone) => {
    revision.current++;
    known.current.set(job.id, job.status);
    setJobs((previous) => [job, ...previous.filter((entry) => entry.id !== job.id)]);
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const started = revision.current;
      try {
        const { data } = await api.projectClones(controller.signal);
        if (controller.signal.aborted || started !== revision.current) return;
        for (const job of data) {
          const previous = known.current.get(job.id);
          if (previous && cloneRunning({ status: previous }) && !cloneRunning(job)) setNotice(job);
          known.current.set(job.id, job.status);
        }
        setJobs(data);
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    const resume = () => refresh();
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
    };
  }, [enabled, refreshKey, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 12_000);
    return () => clearTimeout(timer);
  }, [notice]);
  return { jobs, error, notice, accept, refresh, dismiss: () => setNotice(undefined) };
}
export type BackgroundTaskState = ReturnType<typeof useBackgroundTasks>;

import type { ProjectClone } from '../../shared/types';
import { t, formatNumber } from '../i18n';

/** Older servers still show a localized lifecycle state without parsing their prose. */
export function cloneProgress(job: ProjectClone): string {
  const stage =
    job.progressStage ??
    (job.status === 'cloning'
      ? 'connecting'
      : job.status === 'registration-failed'
        ? 'registration_failed'
        : job.status);
  return t(`sidebar:clone_stage_${stage}`);
}

export const cloneRunning = (job?: Pick<ProjectClone, 'status'>) =>
  job?.status === 'cloning' || job?.status === 'cancelling';

export function cloneProgressLabel(job: ProjectClone): string {
  return job.percent === undefined
    ? cloneProgress(job)
    : t('sidebar:clone_progress_percent', {
        v0: cloneProgress(job),
        v1: formatNumber(job.percent / 100, { style: 'percent', maximumFractionDigits: 0 }),
      });
}

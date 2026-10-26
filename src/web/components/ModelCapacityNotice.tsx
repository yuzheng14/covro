import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';

/** Capacity progress belongs beside the existing capacity error, not the network notice. */
export function ModelCapacityNotice({
  progress,
  details,
  children,
  offline = false,
  retrying = false,
  testId = 'model-capacity-status',
  state = 'failed',
}: {
  progress?: ReactNode;
  details?: string;
  children?: ReactNode;
  offline?: boolean;
  retrying?: boolean;
  testId?: string;
  state?: string;
}) {
  return (
    <div
      className="error-banner model-capacity-notice"
      role={retrying ? 'status' : 'alert'}
      aria-label={t('conversation:model_capacity_unavailable')}
      data-testid={testId}
      data-state={state}
    >
      <div className="model-capacity-heading">
        <span className="model-capacity-label">
          <Icon name="alert" size={16} />
          {offline && t('common:last_known')}
          {t('conversation:model_capacity_unavailable')}
        </span>
        {progress && <div className="model-capacity-progress">{progress}</div>}
      </div>
      {children}
      {details && (
        <details className="model-capacity-details">
          <summary>{t('conversation:error_details')}</summary>
          <p className="codex-reconnect-message">{details}</p>
        </details>
      )}
    </div>
  );
}

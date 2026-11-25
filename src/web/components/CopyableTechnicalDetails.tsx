import { useCopyText } from '../hooks/useCopyText';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Button } from './ui/button';
import './copyable-technical-details.css';

export function CopyableTechnicalDetails({ text }: { text: string }) {
  const { copy, feedback } = useCopyText();
  return (
    <details className="copyable-technical-details">
      <summary>{t('common:technical_details')}</summary>
      <div className="technical-details-copy">
        <Button variant="secondary" size="sm" onClick={() => void copy(text)}>
          <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={16} />
          {t('common:copy_technical_details')}
        </Button>
        <span role="status" data-state={feedback}>
          {feedback === 'copied' && t('common:copied')}
          {feedback === 'failed' && t('common:technical_details_copy_failed')}
        </span>
      </div>
      <pre>{text}</pre>
    </details>
  );
}

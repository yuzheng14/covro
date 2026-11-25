import { useCopyText } from '../hooks/useCopyText';
import { t } from '../i18n';
import { Button } from './ui/button';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';
import './command-output-copy.css';

export function CommandOutputCopyButton({
  output,
  truncated = false,
}: {
  output: string;
  truncated?: boolean;
}) {
  const { copy, feedback } = useCopyText();

  return (
    <>
      <ControlHint asChild content={t('conversation:copy_loaded_command_output')}>
        <Button
          variant="ghost"
          size="icon"
          className="command-output-copy-button"
          aria-label={t('conversation:copy_command_output')}
          disabled={!output}
          onClick={() => void copy(output)}
        >
          <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={16} />
        </Button>
      </ControlHint>
      <span
        className={`command-output-copy-feedback command-output-copy-${feedback}`}
        role="status"
      >
        {feedback === 'failed'
          ? t('conversation:command_output_copy_failed')
          : truncated
            ? t(
                feedback === 'copied'
                  ? 'conversation:copied_truncated_command_output'
                  : 'conversation:command_output_truncated',
              )
            : feedback === 'copied'
              ? t('common:copied')
              : ''}
      </span>
    </>
  );
}

import { t } from '../i18n';
import type { TurnView } from '../../shared/types';
import { formatTurnCompletedAt, formatTurnDuration } from '../lib/turn-timing';
import { formatTokenCount } from '../lib/context-usage';
import { formatTurnTps } from '../lib/turn-tps';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Icon } from './Icon';
import { ReplyCopyButton } from './ReplyCopyButton';

export function TurnCompletion({ turn }: { turn: TurnView }) {
  if (turn.status !== 'completed') return null;
  const duration = formatTurnDuration(turn.durationMs);
  const completed = formatTurnCompletedAt(turn.completedAt);
  const tps = formatTurnTps(turn.outputTokens, turn.durationMs);
  const reply = turn.items.findLast(
    (item) => item.type === 'agentMessage' && item.text?.trim(),
  )?.text;
  return (
    <div
      className="turn-completion"
      role="group"
      aria-label={t('conversation:turn_completion_details')}
    >
      <span className="turn-completion-status">
        <Icon name="check" size={14} />
        {t('common:completed')}
      </span>
      <span>
        {' '}
        · {duration ? t('conversation:took', { v0: duration }) : t('conversation:duration_unknown')}
      </span>
      <span>
        {' · '}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="turn-tps" tabIndex={0}>
                {tps === undefined
                  ? t('conversation:tps_unknown')
                  : t('conversation:average_tps', { v0: tps })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {tps === undefined
                ? t('conversation:tps_cannot_be_calculated_without_complete_token_counts')
                : t('conversation:output_tokens_including_reasoning_total_turn_duration_in', {
                    v0: formatTokenCount(turn.outputTokens),
                  })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
      <span className="turn-tokens">
        {' · '}
        {turn.totalTokens === undefined
          ? t('conversation:turn_tokens_unknown')
          : t('conversation:turn_tokens', { tokens: formatTokenCount(turn.totalTokens) })}
      </span>
      <span>
        {' · '}
        {completed ? (
          <>
            {t('conversation:completed_at')}{' '}
            <time dateTime={completed.dateTime}>{completed.label}</time>
          </>
        ) : (
          t('conversation:completion_time_unknown')
        )}
      </span>
      {reply && <ReplyCopyButton text={reply} />}
    </div>
  );
}

import { t } from '../i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ThreadView } from '../../shared/types';
import { Button } from './ui/button';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';

/** An overlay keeps the original prompt's geometry unchanged while reading replies. */
export function StickyPrompt({ thread, onJump }: { thread?: ThreadView; onJump: () => void }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>();
  const activePrompt = [
    ...(thread?.turns.flatMap((turn) => turn.items) ?? []),
    ...(thread?.pendingMessages?.map((message) => message.item) ?? []),
  ].find((item) => item.type === 'userMessage' && (item.clientId ?? item.id) === activeId);

  const update = useCallback(() => {
    const scroll = slotRef.current?.parentElement?.querySelector('.conversation-scroll');
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top + scroll.clientTop;
    const prompts = scroll.querySelectorAll<HTMLElement>(
      '.conversation-content .user-message[data-prompt-id]',
    );
    let id: string | undefined;
    for (let index = prompts.length - 1; index >= 0; index--) {
      if (prompts[index]!.getBoundingClientRect().top < top) {
        id = prompts[index]!.dataset.promptId;
        break;
      }
    }
    setActiveId(id);
  }, []);

  useLayoutEffect(update, [thread, update]);
  useEffect(() => {
    const scroll = slotRef.current?.parentElement?.querySelector('.conversation-scroll');
    const content = scroll?.querySelector('.conversation-content');
    if (!scroll || !content) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    // Tool expansion, streamed text, image loading and viewport changes can all move prompts.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener('scroll', schedule, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [update]);

  const imageCount = Math.max(activePrompt?.imageCount ?? 0, activePrompt?.images?.length ?? 0);
  return (
    <div className="sticky-prompt-slot" ref={slotRef}>
      {activePrompt && (
        <ControlHint asChild content={t('conversation:back_to_original_prompt')}>
          <Button
            variant="ghost"
            className="sticky-prompt"
            aria-label={t('conversation:back_to_original_prompt')}
            onClick={(event) => {
              const scroll = slotRef.current?.parentElement?.querySelector('.conversation-scroll');
              const prompt = [
                ...(scroll?.querySelectorAll<HTMLElement>('[data-prompt-id]') ?? []),
              ].find(
                (element) =>
                  element.dataset.promptId === (activePrompt.clientId ?? activePrompt.id),
              );
              if (!scroll || !prompt) return;
              // An earlier prompt may remain pinned after jumping back to a later one.
              const offset = event.currentTarget.getBoundingClientRect().height + 8;
              onJump();
              prompt.focus({ preventScroll: true });
              scroll.scrollTop +=
                prompt.getBoundingClientRect().top -
                scroll.getBoundingClientRect().top -
                scroll.clientTop -
                offset;
            }}
          >
            <span className="sticky-prompt-label">{t('conversation:your_instructions')}</span>
            <span className="sticky-prompt-text">
              {activePrompt.text?.trim() ||
                (imageCount
                  ? t('conversation:images', { count: imageCount, v0: imageCount })
                  : t('conversation:user_prompt'))}
            </span>
            <Icon name="down" size={14} style={{ transform: 'rotate(180deg)' }} />
          </Button>
        </ControlHint>
      )}
    </div>
  );
}

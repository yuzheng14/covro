import { useLayoutEffect, useRef, useState } from 'react';

export function useCopyText() {
  const pending = useRef<symbol>(undefined);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');

  useLayoutEffect(
    () => () => {
      pending.current = undefined;
      clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy(text: string) {
    if (pending.current || !text) return;
    const attempt = Symbol();
    pending.current = attempt;
    clearTimeout(resetTimer.current);
    setFeedback('idle');
    try {
      await navigator.clipboard.writeText(text);
      if (pending.current !== attempt) return;
      setFeedback('copied');
      resetTimer.current = setTimeout(() => setFeedback('idle'), 2000);
    } catch {
      if (pending.current === attempt) setFeedback('failed');
    } finally {
      if (pending.current === attempt) pending.current = undefined;
    }
  }

  return { copy, feedback };
}

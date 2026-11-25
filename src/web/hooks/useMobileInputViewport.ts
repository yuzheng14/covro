import { useEffect, type RefObject } from 'react';

/** Keep the workspace inside the portion of the layout viewport visible during mobile input. */
export function useMobileInputViewport(
  shellRef: RefObject<HTMLDivElement | null>,
  mobile: boolean,
) {
  useEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!mobile || !shell || !viewport) return;
    let frame = 0;
    let adjusted = false;
    const reset = () => {
      if (!adjusted) return;
      adjusted = false;
      shell.removeAttribute('data-mobile-input-viewport');
      shell.style.removeProperty('--input-viewport-height');
      shell.style.removeProperty('--input-viewport-top');
      shell.style.removeProperty('--input-viewport-bottom-inset');
    };
    const measure = () => {
      const editor = document.activeElement;
      const composer =
        editor instanceof HTMLTextAreaElement &&
        editor.closest('.composer-box') &&
        shell.contains(editor);
      const anotherEditor =
        editor instanceof HTMLElement &&
        (editor.matches('input, textarea') || editor.isContentEditable);
      const { height, offsetTop, scale } = viewport;
      const layoutHeight = document.documentElement.clientHeight;
      // Keep the button row stable between blur and the viewport expanding again.
      if (
        scale !== 1 ||
        height <= 0 ||
        (height >= layoutHeight - 1 && Math.abs(offsetTop) <= 1) ||
        (!composer && (!adjusted || anotherEditor))
      ) {
        reset();
        return;
      }
      const resized = shell.style.getPropertyValue('--input-viewport-height') !== `${height}px`;
      shell.style.setProperty('--input-viewport-height', `${height}px`);
      shell.style.setProperty('--input-viewport-top', `${offsetTop}px`);
      // The visible bottom can sit above part or all of the layout viewport's safe area.
      const bottomInset = Math.max(0, layoutHeight - offsetTop - height);
      shell.style.setProperty('--input-viewport-bottom-inset', `${bottomInset}px`);
      shell.setAttribute('data-mobile-input-viewport', '');
      adjusted = true;
      // On very short landscape screens the composer itself may need to scroll.
      // Reveal the action row when the available height changes, without interrupting panning.
      if (resized && composer) {
        const bottom = editor.closest<HTMLElement>('.bottom-region');
        if (bottom) bottom.scrollTop = bottom.scrollHeight;
      }
    };
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      reset();
    };
  }, [shellRef, mobile]);
}

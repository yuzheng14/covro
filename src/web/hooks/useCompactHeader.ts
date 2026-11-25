import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const overlaySidebarQuery =
  '(max-width: 760px), (max-width: 950px) and (max-height: 500px) and (pointer: coarse)';

function desktopFits(header: HTMLElement, status: HTMLElement) {
  header.dataset.measuring = '';
  try {
    const style = getComputedStyle(header);
    const children = Array.from(status.children).filter(
      (child) => !child.hasAttribute('data-compact-action') && child.getClientRects().length > 0,
    );
    // An open popover is in the top layer and does not contribute to the row's width.
    // Count its desktop-sized box explicitly along with the other status controls.
    const statusWidth =
      children.reduce((width, child) => width + child.getBoundingClientRect().width, 0) +
      (children.length - 1) * parseFloat(getComputedStyle(status).columnGap);
    const requiredWidth =
      statusWidth +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.columnGap) +
      parseFloat(style.getPropertyValue('--topbar-title-basis'));
    return header.getBoundingClientRect().width >= requiredWidth;
  } finally {
    delete header.dataset.measuring;
  }
}

export function useCompactHeader(ref: RefObject<HTMLElement | null>) {
  const [compact, setCompact] = useState(() => matchMedia(overlaySidebarQuery).matches);
  const focusedControl = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const header = ref.current;
    const status = header?.querySelector<HTMLElement>('.topbar-status');
    if (!header || !status) return;

    const sidebarOverlay = matchMedia(overlaySidebarQuery);
    const checkFit = () => {
      const next = sidebarOverlay.matches || !desktopFits(header, status);
      if (next === header.hasAttribute('data-compact')) return;
      const active = document.activeElement;
      focusedControl.current =
        active instanceof HTMLElement &&
        (status.contains(active) || active.matches('.topbar-attention .status-trigger')) &&
        !active.closest('.diagnostics-panel')
          ? active
          : null;
      setCompact(next);
    };

    const resize = new ResizeObserver(checkFit);
    const content = new MutationObserver((records) => {
      // Diagnostic details do not contribute to the width of their summary.
      if (
        records.some(({ target }) => {
          const element = target instanceof Element ? target : target.parentElement;
          return element && !element.closest('.diagnostics-panel');
        })
      ) {
        checkFit();
      }
    });
    resize.observe(header, { box: 'border-box' });
    content.observe(status, { childList: true, characterData: true, subtree: true });

    sidebarOverlay.addEventListener('change', checkFit);
    window.addEventListener('resize', checkFit);
    document.fonts.addEventListener('loadingdone', checkFit);
    checkFit();
    return () => {
      resize.disconnect();
      content.disconnect();
      sidebarOverlay.removeEventListener('change', checkFit);
      window.removeEventListener('resize', checkFit);
      document.fonts.removeEventListener('loadingdone', checkFit);
    };
  }, [ref]);

  useLayoutEffect(() => {
    const previous = focusedControl.current;
    focusedControl.current = null;
    if (!previous) return;
    if (previous.isConnected && previous.getClientRects().length > 0) {
      previous.focus({ preventScroll: true });
      return;
    }
    if (previous.classList.contains('status-trigger')) {
      const selector = compact
        ? '.topbar-attention .status-trigger'
        : '.topbar-status .status-trigger';
      ref.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
      return;
    }
    const diagnostics = previous.matches('summary, [aria-controls="diagnostics-panel"]');
    const header = ref.current;
    const target = compact
      ? (diagnostics && header?.querySelector<HTMLElement>('.topbar-diagnostics')) ||
        header?.querySelector<HTMLElement>('.topbar-more')
      : header?.querySelector<HTMLElement>(
          diagnostics ? '.diagnostics > summary' : '.topbar-tools button:not(:disabled)',
        );
    target?.focus({ preventScroll: true });
  }, [compact, ref]);

  return compact;
}

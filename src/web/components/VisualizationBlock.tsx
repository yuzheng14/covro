import { useLayoutEffect, useRef, useState } from 'react';
import { visualizationMessageType, type VisualizationReference } from '../../shared/visualization';
import { t } from '../i18n';

export function VisualizationBlock({
  threadId,
  reference,
}: {
  threadId: string;
  reference: VisualizationReference;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>();
  useLayoutEffect(() => {
    const timeout = window.setTimeout(() => setHeight(null), 15_000);
    function receive(event: MessageEvent) {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== visualizationMessageType
      )
        return;
      if (event.data.unavailable === true) setHeight(null);
      else if (typeof event.data.height === 'number' && Number.isFinite(event.data.height))
        setHeight(Math.max(48, Math.min(800, event.data.height)));
      else return;
      window.clearTimeout(timeout);
    }
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      window.clearTimeout(timeout);
    };
  }, []);

  const src = `/api/threads/${encodeURIComponent(threadId)}/visualization?${new URLSearchParams({ path: reference.path })}`;
  return (
    <div className="visualization-block" data-wide={reference.mode === 'wide' || undefined}>
      {height === null ? (
        <p role="status">{t('preview:visualization_unavailable')}</p>
      ) : (
        <>
          {height === undefined && <p role="status">{t('common:loading_2')}</p>}
          <iframe
            ref={frame}
            src={src}
            title={reference.title ?? t('preview:interactive_visualization')}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ height: height ?? 1, visibility: height === undefined ? 'hidden' : 'visible' }}
          />
        </>
      )}
    </div>
  );
}

import { message, displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { renderMermaid } from '../lib/mermaid';
import { readMermaidTheme, type MermaidTheme } from '../lib/mermaid-theme';
import { Button } from './ui/button';

function useDiagramTheme() {
  const [theme, setTheme] = useState(readMermaidTheme);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const next = readMermaidTheme();
      setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    // App theme selectors change root attributes; media changes only trigger a style reread.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    update();
    query.addEventListener('change', update);
    return () => {
      observer.disconnect();
      query.removeEventListener('change', update);
    };
  }, []);
  return theme;
}

export function MermaidBlock({ source, pending }: { source: string; pending: boolean }) {
  const theme = useDiagramTheme();
  const [result, setResult] = useState<{
    source: string;
    theme: MermaidTheme;
    url?: string;
    failed?: boolean;
  }>();
  const [sourceView, setSourceView] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [feedback, setFeedback] = useState('');
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    void renderMermaid(source, theme, controller.signal).then(
      (url) => {
        if (!controller.signal.aborted) setResult({ source, theme, url });
      },
      () => {
        if (!controller.signal.aborted) setResult({ source, theme, failed: true });
      },
    );
    return () => controller.abort();
  }, [source, theme, pending]);

  const current =
    !pending && result?.source === source && result.theme === theme ? result : undefined;
  const showSource = pending || current?.failed || sourceView;

  async function copy() {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(source);
      setFeedback(message('preview:new_mermaid_source_copied'));
      resetTimer.current = setTimeout(() => setFeedback(''), 2000);
    } catch {
      setSourceView(true);
      setFeedback(message('preview:new_copy_failed_select_and_copy_the_source'));
    } finally {
      copying.current = false;
    }
  }

  return (
    <div
      className="mermaid-block"
      data-theme={theme.dark ? 'dark' : 'light'}
      style={
        {
          '--mermaid-background': theme.background,
          '--mermaid-text': theme.text,
        } as CSSProperties
      }
    >
      <div className="mermaid-toolbar">
        <span className="mermaid-label">Mermaid</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.url}
          aria-pressed={sourceView}
          onClick={() => setSourceView((value) => !value)}
        >
          {sourceView ? t('preview:new_view_diagram') : t('preview:new_view_source')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.url || !!showSource}
          aria-pressed={actualSize}
          onClick={() => setActualSize((value) => !value)}
        >
          {actualSize ? t('preview:new_fit_width') : t('preview:new_actual_size')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {t('preview:new_copy_source')}
        </Button>
      </div>
      {feedback && (
        <p className="mermaid-feedback" role="status">
          {displayMessage(feedback)}
        </p>
      )}
      {pending ? (
        <p className="mermaid-notice" role="status">
          {t('preview:new_receiving_mermaid_source_the_diagram_appears_when')}
        </p>
      ) : current?.failed ? (
        <p className="mermaid-notice mermaid-error" role="alert">
          {t('preview:new_cannot_render_this_mermaid_diagram_check_the')}
        </p>
      ) : !current?.url ? (
        <p className="mermaid-notice" role="status">
          {t('preview:new_rendering_mermaid_diagram')}
        </p>
      ) : null}
      {showSource ? (
        <pre className="mermaid-source" tabIndex={0} aria-label={t('preview:new_mermaid_source')}>
          <code>{source}</code>
        </pre>
      ) : current?.url ? (
        <div
          className={`mermaid-diagram${actualSize ? ' mermaid-actual-size' : ''}`}
          role="region"
          aria-label={t('preview:new_mermaid_diagram_region')}
          tabIndex={0}
        >
          <img
            src={current.url}
            alt={t('preview:new_mermaid_diagram')}
            onError={() => setResult({ source, theme, failed: true })}
          />
        </div>
      ) : null}
    </div>
  );
}

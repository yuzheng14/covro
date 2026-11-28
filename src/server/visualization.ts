import { extname, isAbsolute } from 'node:path';
import { AppError } from '../shared/errors.js';
import { visualizationMessageType } from '../shared/visualization.js';
import { readLocalFile, type FileScope } from './local-files.js';

export const visualizationCsp =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export async function readLocalVisualization(path: string | undefined, scope: FileScope) {
  if (!path || !isAbsolute(path))
    throw new AppError('INVALID_VISUALIZATION_PATH', '可视化文件需要绝对路径', 400);
  const { bytes } = await readLocalFile(path, scope, {
    code: 'VISUALIZATION',
    label: '可视化',
    maxBytes: 1024 * 1024,
    sizeError: '可视化文件超过 1 MiB 预览限制',
    validatePath(candidate) {
      if (extname(candidate).toLowerCase() !== '.html')
        throw new AppError('UNSUPPORTED_VISUALIZATION_TYPE', '可视化需要 .html 文件', 415);
    },
  });
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.trim() || content.includes('\0')) throw new Error('Invalid HTML text');
    return content;
  } catch {
    throw new AppError('INVALID_VISUALIZATION_CONTENT', '可视化需要 UTF-8 HTML 文本', 415);
  }
}

export function visualizationDocument(content?: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  :root {
    color-scheme: light dark;
    --font-size-base: 14px;
    --background: light-dark(#fff, #23262b);
    --foreground: light-dark(#242a30, #f1f2f4);
    --muted: light-dark(#eef1f3, #343840);
    --muted-foreground: light-dark(#57616c, #b8c1cb);
    --border: light-dark(#dee3e7, #464c55);
    --card: var(--background);
    --card-foreground: var(--foreground);
    --primary: var(--foreground);
    --primary-foreground: var(--background);
    --secondary: var(--muted);
    --secondary-foreground: var(--foreground);
    --accent: light-dark(#e8f2ec, #33473d);
    --accent-foreground: var(--foreground);
    --input: var(--border);
    --ring: light-dark(#276346, #8cc8a6);
    --blue: light-dark(#245d9c, #8cc2ff);
    --green: light-dark(#276346, #8cc8a6);
    --red: light-dark(#ad3038, #ff9ca3);
    --destructive: var(--red);
    --orange: light-dark(#a7491c, #ffb48e);
    --yellow: light-dark(#856013, #f4d17b);
    --purple: light-dark(#7543a0, #d5adfa);
    --viz-series-1: var(--blue);
    --viz-series-2: var(--green);
    --viz-series-3: var(--orange);
    --viz-series-4: var(--purple);
    --viz-series-5: var(--red);
    --viz-series-6: var(--yellow);
    font: var(--font-size-base)/1.55 system-ui, sans-serif;
    color: var(--foreground);
  }
  *, ::before, ::after { box-sizing: border-box; }
  body, h1, h2, h3, p { margin: 0; }
  #covro-visualization-content { display: flow-root; padding: 12px; overflow-wrap: anywhere; }
  button, select, input, textarea { font: inherit; }
  button, select, input[type=range], input[type=checkbox] { accent-color: var(--ring); }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .viz-row, .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .75em; }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .text-small { font-size: .86em; }
  .text-muted { color: var(--muted-foreground); }
  .btn { padding: .4em .85em; border: 1px solid var(--border); border-radius: .55em;
    color: var(--foreground); background: var(--background); }
  .btn-primary { color: var(--primary-foreground); background: var(--primary); }
  .btn-ghost { background: transparent; border-color: transparent; }
  .btn-block { display: block; width: 100%; }
  .progress { height: .5em; border-radius: 999px; overflow: hidden; background: var(--muted); }
  .progress-bar { height: 100%; background: var(--viz-series-1); }
  .card { padding: 1em; border: 1px solid var(--border); border-radius: .75em; }
  .viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(11em, 100%), 1fr)); gap: .75em; }
</style></head>
<body><div id="covro-visualization-content">${content ?? ''}</div>
<script>
  (() => {
    const type = ${JSON.stringify(visualizationMessageType)};
    if (${content === undefined}) {
      parent.postMessage({ type, unavailable: true }, '*');
      return;
    }
    const content = document.getElementById('covro-visualization-content');
    const reportSize = () => {
      parent.postMessage({ type, height: Math.ceil(content.getBoundingClientRect().height) }, '*');
    };
    new ResizeObserver(reportSize).observe(content);
    reportSize();
  })();
</script></body></html>`;
}

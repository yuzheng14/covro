import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { localPreviewPath, relativeToFile } from '../../src/web/lib/local-files';
import { MarkdownContent } from '../../src/web/components/MarkdownContent';
import { FilePreviewProvider } from '../../src/web/components/FilePreviewProvider';

it('renders release Markdown safely and resolves relative links outside local file previews', () => {
  const html = renderToStaticMarkup(
    createElement(FilePreviewProvider, {
      threadId: 'thread',
      children: createElement(MarkdownContent, {
        text: '## Features\n\n- **New feature**\n\n[Guide](docs/guide.md) [Issue](https://github.com/yuzheng14/covro/issues/225) [Unsafe](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
        externalBaseUrl: 'https://github.com/yuzheng14/covro/blob/v0.4.0/',
      }),
    }),
  );
  expect(html).toContain('<h2>Features</h2>');
  expect(html).toContain('<strong>New feature</strong>');
  expect(html).toContain('href="https://github.com/yuzheng14/covro/blob/v0.4.0/docs/guide.md"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain('/api/threads/');
  expect(html).not.toMatch(/<script|onerror|javascript:/);
});

it.each([
  ['./docs/方案%20说明.md', './docs/方案 说明.md'],
  ['file:///work/README.MD#L20', '/work/README.MD'],
  ['docs/README.markdown:12:3', 'docs/README.markdown'],
  ['/work/literal%2520.md', '/work/literal%20.md'],
  ['docs/readme.md?raw=1#section', 'docs/readme.md'],
])('recognizes one local Markdown destination: %s', (input, expected) => {
  expect(localPreviewPath(input)).toBe(expected);
});
it.each([
  'https://example.com/README.md',
  '//host/README.md',
  'file://remote/README.md',
  'javascript:alert(1).md',
  '%68ttps%3A%2F%2Fexample.com/a.md',
  'docs/%00.md',
  'docs/%5C.md',
  'docs/%ZZ.md',
  'docs/file.pdf',
  '#section',
  '',
])('keeps nonlocal or unsafe destinations out of the file reader: %s', (input) => {
  expect(localPreviewPath(input)).toBeUndefined();
});
it('resolves nested documents and image paths relative to the open document', () => {
  expect(relativeToFile('../next.md', '/work/docs/plan.md')).toBe('/work/docs/../next.md');
  expect(relativeToFile('images/chart.png', '/work/docs/plan.md')).toBe(
    '/work/docs/images/chart.png',
  );
  expect(relativeToFile('/tmp/file.md', '/work/docs/plan.md')).toBe('/tmp/file.md');
  expect(relativeToFile('docs/plan.md')).toBe('docs/plan.md');
});
it('routes local documents through the authenticated preview and leaves external links alone', () => {
  const html = renderToStaticMarkup(
    createElement(FilePreviewProvider, {
      threadId: 'thread',
      children: createElement(MarkdownContent, {
        text: '[本地](file:///work/plan.md) [下一页](next.md) [外部](https://example.com/README.md) [危险](javascript:alert%281%29) [历史会话](codex://threads/saved-thread)',
        baseFile: '/work/docs/readme.md',
      }),
    }),
  );
  expect(html).toContain('/api/threads/thread/markdown?path=%2Fwork%2Fplan.md');
  expect(html).toContain('/api/threads/thread/markdown?path=%2Fwork%2Fdocs%2Fnext.md');
  expect(html).toContain('href="https://example.com/README.md"');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('href="file:');
  expect(html).toContain('历史会话');
  expect(html).not.toContain('codex://');
  expect(html).not.toContain('saved-thread');
});

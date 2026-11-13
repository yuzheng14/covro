import { expect, it } from 'vitest';
import { VitePreviewAdapter } from '../../src/server/preview/vite.js';
const prefix = '/preview/' + 'x'.repeat(43) + '/';
const origin = 'https://covro.example';
it('rewrites syntax rather than comments, regexes or unrelated literals', async () => {
  const adapter = new VitePreviewAdapter();
  const output = await adapter.transform(
    `// import('/comment.js')\nconst pattern=/\\/literal/;const unrelated='/keep';import value from '/module.js';export {x} from './export.js';import('/dynamic.js');new URL('/logo.svg',import.meta.url);const props={src:'/image.png',href:'/route',srcSet:'/a.png 1x, /b.png 2x'};`,
    'text/javascript',
    '/src/main.js',
    prefix,
    origin,
  );
  expect(output).toContain("// import('/comment.js')");
  expect(output).toContain("const unrelated='/keep'");
  for (const path of [
    'module.js',
    'src/export.js',
    'dynamic.js',
    'logo.svg',
    'image.png',
    'route',
    'a.png',
    'b.png',
  ])
    expect(output).toContain(prefix + path);
});
it('adapts HTML, import maps, CSS and data URLs without rewriting a data comma', async () => {
  const adapter = new VitePreviewAdapter();
  const html = await adapter.transform(
    `<html><head><base href="/"><script type="importmap">{"imports":{"app":"/app.js"}}</script><style>a{background:url('/logo.svg')}</style></head><body><img src="/logo.svg" srcset="data:image/png;base64,AA 1x, /logo.svg 2x"><script type="module" src="/main.js"></script></body></html>`,
    'text/html',
    '/',
    prefix,
    origin,
  );
  expect(html).toContain(prefix + 'app.js');
  expect(html).toContain(prefix + 'main.js');
  expect(html).toContain('data:image/png;base64,AA 1x, ' + prefix + 'logo.svg 2x');
  expect(html).toContain('crossorigin="use-credentials"');
  expect(html).not.toContain('<base href');
  const css = await adapter.transform(
    `@import '/public.css';a{background:url(/logo.svg)}b{background:url(data:image/png;base64,AA)}`,
    'text/css',
    '/style.css',
    prefix,
    origin,
  );
  expect(css).toContain(prefix + 'public.css');
  expect(css).toContain(prefix + 'logo.svg');
  expect(css).toContain('data:image/png;base64,AA');
});
it('fails closed on unknown Vite client shapes and filters custom HMR events', async () => {
  const adapter = new VitePreviewAdapter();
  await expect(
    adapter.transform('const unknown="/";', 'text/javascript', '/@vite/client', prefix, origin),
  ).rejects.toMatchObject({ code: 'PREVIEW_ADAPTER' });
  expect(adapter.hmr('/__vite_hmr?token=unknown', 'vite-hmr', prefix)).toBeUndefined();
  expect(adapter.hmrMessage('{"type":"custom","event":"business"}')).toBeUndefined();
  expect(
    adapter.hmrMessage(
      '{"type":"update","updates":[{"type":"js-update","path":"https://elsewhere.invalid/"}]}',
    ),
  ).toBeUndefined();
});

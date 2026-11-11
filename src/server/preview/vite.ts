import { parse as htmlParse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { parse as javascriptParse, type Node } from 'acorn';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import type { PreviewAdapter } from './proxy.js';
import { AppError } from '../../shared/errors.js';

type Ast = Node & Record<string, unknown>;
type Element = DefaultTreeAdapterMap['element'];
interface Edit {
  start: number;
  end: number;
  value: string;
}
interface Hmr {
  token: string;
  path: string;
}
type Loader = (path: string) => Promise<Response>;
const fail = (message: string): never => {
  throw new AppError('PREVIEW_ADAPTER', message, 422);
};
function rewriteUrl(value: string, path: string, prefix: string) {
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value) || value.startsWith(prefix))
    return value;
  const url = new URL(value, 'http://preview.invalid' + path);
  return prefix + url.pathname.slice(1) + url.search + url.hash;
}
function srcset(value: string, path: string, prefix: string) {
  return mapSrcset(value, (url) => rewriteUrl(url, path, prefix));
}
function mapSrcset(value: string, map: (url: string) => string) {
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/[\s,]/.test(value[index] ?? '') && index < value.length) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index]!)) index++;
    let url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(',')) {
      candidates.push(map(url.replace(/,+$/, '')));
      continue;
    }
    const descriptor = index;
    let parentheses = 0;
    while (index < value.length) {
      if (value[index] === '(') parentheses++;
      if (value[index] === ')') parentheses--;
      if (value[index] === ',' && parentheses === 0) break;
      index++;
    }
    // Data URL commas belong to the URL, rather than splitting candidates.
    if (!url.startsWith('data:') && url.includes(',')) {
      const urls = url.split(',');
      url = urls.pop()!;
      candidates.push(...urls.filter(Boolean).map(map));
    }
    candidates.push(map(url) + value.slice(descriptor, index));
    index++;
  }
  return candidates.join(', ');
}
function children(node: Ast) {
  const result: { node: Ast; key: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value))
      for (const entry of value) {
        if (entry && typeof entry.type === 'string') result.push({ node: entry, key });
      }
    else if (value && typeof value === 'object' && 'type' in value)
      result.push({ node: value as Ast, key });
  }
  return result;
}
function edits(body: string, edits: Edit[]) {
  let last = body.length + 1;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > last) continue;
    body = body.slice(0, edit.start) + edit.value + body.slice(edit.end);
    last = edit.start;
  }
  // Original maps describe unmodified sources and can expose unadapted imports.
  return body.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '');
}

/** Syntax-aware resource adaptation, bounded to the registered target. No project writes. */
export class VitePreviewAdapter implements PreviewAdapter {
  private readonly clients = new Map<string, Hmr>();
  forget(prefix: string) {
    this.clients.delete(prefix);
  }
  async transform(
    body: string,
    type: string,
    path: string,
    prefix: string,
    origin: string,
    load?: Loader,
  ) {
    if (type === 'text/html') return this.html(body, path, prefix, origin, load);
    if (type === 'text/css') return this.css(body, path, prefix, load);
    return this.javascript(body, path, prefix, origin, load);
  }
  private async css(body: string, path: string, prefix: string, load?: Loader) {
    const root = postcss.parse(body, { from: undefined });
    const pending: Promise<void>[] = [];
    let embeddedFontBytes = 0;
    root.walkDecls((declaration) => {
      const fonts: Promise<void>[] = [];
      const value = valueParser(declaration.value);
      const font =
        declaration.parent?.type === 'atrule' &&
        declaration.parent.name.toLowerCase() === 'font-face';
      value.walk((node) => {
        if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
        const argument = node.nodes[0];
        if (!argument || !['word', 'string'].includes(argument.type)) return;
        const original = argument.value;
        const decoded = original.replace(
          /\\([0-9a-f]{1,6}\s?|[\s\S])/gi,
          (_match, escaped: string) =>
            /^[0-9a-f]/i.test(escaped)
              ? String.fromCodePoint(Math.min(parseInt(escaped.trim(), 16) || 0xfffd, 0x10ffff))
              : /[\r\n]/.test(escaped)
                ? ''
                : escaped,
        );
        argument.value = rewriteUrl(decoded, path, prefix);
        if (font && load && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(original))
          fonts.push(
            (async () => {
              const response = await load(argument.value);
              const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
              if (!/^(?:font\/|application\/(?:font-|vnd\.ms-fontobject))/.test(mime))
                fail('A font URL did not return a supported font');
              const reader = response.body?.getReader();
              const chunks: Uint8Array[] = [];
              let size = 0;
              try {
                if (reader)
                  for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.length;
                    embeddedFontBytes += value.length;
                    if (size > 8 * 1024 * 1024 || embeddedFontBytes > 12 * 1024 * 1024)
                      fail('Preview fonts exceed the 8 MiB per-font or 12 MiB CSS budget');
                    chunks.push(value);
                  }
              } finally {
                await reader?.cancel().catch(() => {});
              }
              const bytes = Buffer.concat(chunks);
              argument.value = `data:${mime};base64,${bytes.toString('base64')}`;
            })(),
          );
      });
      pending.push(
        Promise.all(fonts).then(() => {
          declaration.value = value.toString();
        }),
      );
    });
    root.walkAtRules('import', (rule) => {
      const value = valueParser(rule.params);
      value.walk((node) => {
        if (node.type === 'string') node.value = rewriteUrl(node.value, path, prefix);
        if (
          node.type === 'function' &&
          node.value.toLowerCase() === 'url' &&
          node.nodes[0]?.type === 'word'
        )
          node.nodes[0].value = rewriteUrl(node.nodes[0].value, path, prefix);
      });
      rule.params = value.toString();
    });
    await Promise.all(pending);
    return root.toString();
  }
  private async javascript(
    body: string,
    path: string,
    prefix: string,
    origin: string,
    load?: Loader,
  ) {
    let root: Ast;
    try {
      root = javascriptParse(body, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
      }) as unknown as Ast;
    } catch {
      return fail('JavaScript syntax is not supported by the preview adapter');
    }
    const changes: Edit[] = [];
    const pending: Promise<void>[] = [];
    const client = path.split('?')[0]?.endsWith('/@vite/client');
    const declarations = new Map<string, Ast>();
    const environment = new WeakSet<Ast>();
    const visit = (node: Ast, parent?: Ast) => {
      if (
        node.type === 'AssignmentExpression' &&
        (node.left as Ast)?.type === 'MemberExpression' &&
        ((node.left as Ast).object as Ast)?.type === 'MetaProperty' &&
        ((node.left as Ast).property as Ast)?.name === 'env' &&
        (node.right as Ast)?.type === 'ObjectExpression'
      )
        for (const property of (node.right as Ast).properties as Ast[]) environment.add(property);
      if (node.type === 'VariableDeclarator' && (node.id as Ast)?.type === 'Identifier')
        declarations.set(String((node.id as Ast).name), node.init as Ast);
      if (node.type === 'Literal' && typeof node.value === 'string') {
        const key =
          parent?.type === 'Property'
            ? String((parent.key as Ast)?.name ?? (parent.key as Ast)?.value)
            : '';
        const source =
          parent &&
          [
            'ImportDeclaration',
            'ExportNamedDeclaration',
            'ExportAllDeclaration',
            'ImportExpression',
          ].includes(parent.type) &&
          parent.source === node &&
          /^(?:[./]|[a-z][a-z0-9+.-]*:)/i.test(node.value);
        const url =
          parent?.type === 'NewExpression' &&
          (parent.callee as Ast)?.name === 'URL' &&
          (parent.arguments as Ast[])[0] === node;
        const attribute =
          parent?.type === 'Property' &&
          parent.value === node &&
          ['src', 'href', 'poster', 'srcSet', 'srcset'].includes(key);
        const assigned =
          parent?.type === 'AssignmentExpression' &&
          parent.right === node &&
          ['src', 'href', 'poster', 'srcset'].includes(
            String(((parent.left as Ast)?.property as Ast)?.name),
          );
        const base =
          parent?.type === 'Property' &&
          environment.has(parent) &&
          parent.value === node &&
          key === 'BASE_URL';
        if (source || url || attribute || assigned || base) {
          const value =
            key.toLowerCase() === 'srcset'
              ? srcset(node.value, path, prefix)
              : rewriteUrl(node.value, path, prefix);
          if (value !== node.value)
            changes.push({ start: node.start, end: node.end, value: JSON.stringify(value) });
        }
        if (parent?.type === 'VariableDeclarator' && (parent.id as Ast)?.name === '__vite__css')
          pending.push(
            this.css(node.value, path, prefix, load).then((value) => {
              changes.push({ start: node.start, end: node.end, value: JSON.stringify(value) });
            }),
          );
        if (
          (parent?.type === 'Property' &&
            parent.value === node &&
            ['background', 'backgroundImage', 'maskImage', 'listStyleImage', 'cursor'].includes(
              key,
            )) ||
          (parent?.type === 'AssignmentExpression' &&
            parent.right === node &&
            ['background', 'backgroundImage', 'maskImage', 'listStyleImage', 'cursor'].includes(
              String(((parent.left as Ast)?.property as Ast)?.name),
            ))
        )
          pending.push(
            this.css(`a{background:${node.value}}`, path, prefix, load).then((css) => {
              changes.push({
                start: node.start,
                end: node.end,
                value: JSON.stringify(css.slice(css.indexOf(':') + 1, css.lastIndexOf('}'))),
              });
            }),
          );
      }
      if (
        client &&
        node.type === 'UnaryExpression' &&
        node.operator === 'typeof' &&
        (node.argument as Ast)?.name === 'SharedWorker'
      )
        changes.push({ start: node.start, end: node.end, value: '"undefined"' });
      for (const child of children(node)) visit(child.node, node);
    };
    visit(root);
    if (client) {
      const token = declarations.get('wsToken')?.value;
      const socketHost = declarations.get('socketHost');
      const originalPath =
        socketHost?.type === 'TemplateLiteral'
          ? (socketHost.expressions as Ast[]).at(-1)?.value
          : undefined;
      if (
        typeof token !== 'string' ||
        typeof originalPath !== 'string' ||
        !originalPath.startsWith('/') ||
        !declarations.has('directSocketHost') ||
        !declarations.has('base')
      )
        fail('This Vite HMR client requires an updated preview adapter');
      this.clients.set(prefix, { token: token as string, path: originalPath as string });
      // Bound adapter metadata to the maximum live capability count.
      if (this.clients.size > 256) this.clients.delete(this.clients.keys().next().value!);
      const publicUrl = new URL(origin);
      const baseNode = declarations.get('base');
      const nativeBase =
        typeof baseNode?.value === 'string' ? baseNode.value : (baseNode?.left as Ast)?.value;
      const browserBase = rewriteUrl(
        typeof nativeBase === 'string' ? nativeBase : '/',
        '/',
        prefix,
      );
      for (const [name, value] of Object.entries({
        socketHost: publicUrl.host + prefix + '__vite_hmr',
        directSocketHost: publicUrl.host + prefix + '__vite_hmr',
        socketProtocol: publicUrl.protocol === 'https:' ? 'wss' : 'ws',
        base: browserBase,
        base$1: browserBase,
      })) {
        const node = declarations.get(name);
        if (node) changes.push({ start: node.start, end: node.end, value: JSON.stringify(value) });
      }
    }
    await Promise.all(pending);
    return edits(body, changes);
  }
  private async html(body: string, path: string, prefix: string, origin: string, load?: Loader) {
    const root = htmlParse(body);
    const pending: Promise<void>[] = [];
    let head: Element | undefined;
    const visit = (node: DefaultTreeAdapterMap['node']) => {
      if ('tagName' in node) {
        const element = node as Element;
        if (element.tagName === 'head') head = element;
        if (element.tagName === 'base') element.attrs = [];
        const attr = (name: string) => element.attrs.find((a) => a.name === name);
        for (const a of element.attrs) {
          if (['src', 'href', 'poster', 'action'].includes(a.name))
            a.value = rewriteUrl(a.value, path, prefix);
          if (['srcset', 'imagesrcset'].includes(a.name)) a.value = srcset(a.value, path, prefix);
          if (a.name === 'style')
            pending.push(
              this.css(`a{${a.value}}`, path, prefix, load).then((css) => {
                a.value = css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
              }),
            );
        }
        if (['script', 'link', 'img'].includes(element.tagName)) {
          if (attr('crossorigin')) attr('crossorigin')!.value = 'use-credentials';
          else element.attrs.push({ name: 'crossorigin', value: 'use-credentials' });
        }
        if (element.tagName === 'script' && attr('type')?.value === 'importmap') {
          for (const child of element.childNodes)
            if (child.nodeName === '#text' && 'value' in child) {
              const map = JSON.parse(child.value) as {
                imports?: Record<string, string>;
                scopes?: Record<string, Record<string, string>>;
              };
              const rewriteMap = (values: Record<string, string>) =>
                Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [
                    key.startsWith('/') || key.startsWith('.')
                      ? rewriteUrl(key, path, prefix)
                      : key,
                    rewriteUrl(value, path, prefix),
                  ]),
                );
              if (map.imports) map.imports = rewriteMap(map.imports);
              if (map.scopes)
                map.scopes = Object.fromEntries(
                  Object.entries(map.scopes).map(([scope, values]) => [
                    rewriteUrl(scope, path, prefix),
                    rewriteMap(values),
                  ]),
                );
              child.value = JSON.stringify(map).replace(/</g, '\\u003c');
            }
        }
        if (
          element.tagName === 'script' &&
          !attr('src') &&
          (!attr('type') ||
            ['module', 'text/javascript', 'application/javascript'].includes(attr('type')!.value))
        ) {
          for (const child of element.childNodes)
            if (child.nodeName === '#text' && 'value' in child)
              pending.push(
                this.javascript(child.value, path, prefix, origin, load).then((value) => {
                  child.value = value;
                }),
              );
        }
        if (element.tagName === 'style')
          for (const child of element.childNodes)
            if (child.nodeName === '#text' && 'value' in child)
              pending.push(
                this.css(child.value, path, prefix, load).then((value) => {
                  child.value = value;
                }),
              );
      }
      if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    };
    visit(root);
    await Promise.all(pending);
    if (head) {
      const script = htmlParse(
        `<script>{const __name=(value)=>value;(${bootstrap.toString().replace(/<\/script/gi, '<\\/script')})(${JSON.stringify(prefix)},${mapSrcset.toString().replace(/<\/script/gi, '<\\/script')});}</script>`,
      );
      const element = (script.childNodes.find((n) => 'tagName' in n) as Element).childNodes.find(
        (n) => 'tagName' in n && n.tagName === 'head',
      ) as Element;
      for (const node of element.childNodes) {
        node.parentNode = head;
        head.childNodes.unshift(node);
      }
    }
    return serialize(root);
  }
  hmr(path: string, protocols: string, prefix: string) {
    const config = this.clients.get(prefix);
    const url = new URL(path, 'http://preview.invalid');
    if (!config || url.pathname !== '/__vite_hmr') return;
    if (protocols === 'vite-ping' && !url.search)
      return { path: config.path, protocol: 'vite-ping' };
    if (
      protocols !== 'vite-hmr' ||
      url.searchParams.get('token') !== config.token ||
      [...url.searchParams.keys()].some((key) => key !== 'token')
    )
      return;
    return {
      path: config.path + '?token=' + encodeURIComponent(config.token),
      protocol: 'vite-hmr',
    };
  }
  hmrMessage(data: string) {
    try {
      const value = JSON.parse(data);
      if (!['connected', 'update', 'full-reload', 'prune', 'error', 'ping'].includes(value.type))
        return;
      if (
        value.type === 'update' &&
        (!Array.isArray(value.updates) ||
          value.updates.some(
            (u: { type: string; path: string; acceptedPath: string }) =>
              !['js-update', 'css-update'].includes(u.type) ||
              !u.path?.startsWith('/') ||
              (u.acceptedPath && !u.acceptedPath.startsWith('/')),
          ))
      )
        return;
      return data;
    } catch {
      return;
    }
  }
}

/** Runs inside the opaque document; all requests retain a run prefix and edge credentials. */
function bootstrap(
  prefix: string,
  mapSrcset: (value: string, map: (url: string) => string) => string,
) {
  const rewrite = (input: string) => {
    const url = new URL(input, location.href);
    if (url.origin === location.origin && !url.pathname.startsWith(prefix))
      url.pathname = prefix + url.pathname.slice(1);
    return url.href;
  };
  const originalFetch = window.fetch.bind(window);
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  };
  // A plain POST avoids credentialless CORS preflights at an existing access
  // gateway. The server still validates the capability, identity, method, target
  // and current full-request setting for each envelope.
  window.fetch = async (input, options) => {
    let target = rewrite(input instanceof Request ? input.url : String(input));
    const request =
      input instanceof Request ? new Request(input, options) : new Request(target, options);
    const bytes = new Uint8Array(await request.arrayBuffer());
    let method = request.method;
    const headers = new Headers(request.headers);
    for (let redirects = 0; redirects <= 10; redirects++) {
      const response = await originalFetch(prefix + '__covro_request', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        mode: 'cors',
        credentials: 'include',
        signal: request.signal,
        body: JSON.stringify({
          url: target,
          method,
          headers: Object.fromEntries(headers),
          ...(!['GET', 'HEAD'].includes(method) ? { body: encode(bytes) } : {}),
        }),
      });
      const redirect = response.headers.get('X-Covro-Redirect');
      if (!redirect) {
        Object.defineProperty(response, 'url', { value: target });
        return response;
      }
      if (request.redirect === 'error') throw new TypeError('Preview request redirected');
      const status = Number(response.headers.get('X-Covro-Redirect-Status'));
      if (request.redirect === 'manual')
        return new Response(null, { status, headers: { Location: redirect } });
      target = new URL(redirect, location.href).href;
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        headers.delete('content-type');
      }
    }
    throw new TypeError('Too many preview redirects');
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  const requests = new WeakMap<
    XMLHttpRequest,
    { url: string; method: string; headers: Headers; async: boolean }
  >();
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const headers = new Headers();
    if (rest[1] !== undefined && rest[1] !== null)
      headers.set(
        'authorization',
        'Basic ' +
          encode(
            new TextEncoder().encode(
              `${String(rest[1])}:${rest[2] == null ? '' : String(rest[2])}`,
            ),
          ),
      );
    requests.set(this, {
      url: rewrite(String(url)),
      method: method.toUpperCase(),
      headers,
      async: rest[0] !== false,
    });
    const result = Reflect.apply(open, this, [
      'POST',
      prefix + '__covro_request',
      rest[0] !== false,
    ]);
    this.withCredentials = true;
    return result;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const request = requests.get(this);
    if (request) request.headers.append(name, value);
    else setHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const request = requests.get(this);
    if (!request) return send.call(this, body);
    const submit = (bytes: Uint8Array) => {
      setHeader.call(this, 'Content-Type', 'text/plain');
      send.call(
        this,
        JSON.stringify({
          ...request,
          async: undefined,
          headers: Object.fromEntries(request.headers),
          body: encode(bytes),
        }),
      );
    };
    if (body == null) submit(new Uint8Array());
    else if (typeof body === 'string') submit(new TextEncoder().encode(body));
    else if (body instanceof ArrayBuffer) submit(new Uint8Array(body));
    else if (ArrayBuffer.isView(body))
      submit(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    else if (request.async && (body instanceof Blob || body instanceof FormData)) {
      const encoded = new Request(request.url, { method: 'POST', body });
      const type = encoded.headers.get('content-type');
      if (type) request.headers.set('content-type', type);
      void encoded
        .arrayBuffer()
        .then((bytes) => submit(new Uint8Array(bytes)))
        .catch(() => this.dispatchEvent(new Event('error')));
    } else throw new TypeError('This XMLHttpRequest body is unsupported in isolated preview');
  };
  const NativeEventSource = EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(input: string | URL) {
      super(rewrite(String(input)), { withCredentials: true });
    }
  };
  const NativeWebSocket = WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(input: string | URL, protocols?: string | string[]) {
      const url = new URL(input, location.href);
      if (url.host === location.host && !url.pathname.startsWith(prefix))
        url.pathname = prefix + url.pathname.slice(1);
      url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
      super(url, protocols);
    }
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (data, unused, url) =>
      original(data, unused, url == null ? url : rewrite(String(url)));
  }
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (['src', 'href', 'poster', 'action'].includes(name.toLowerCase())) value = rewrite(value);
    if (['srcset', 'imagesrcset'].includes(name.toLowerCase())) value = mapSrcset(value, rewrite);
    return attribute.call(this, name, value);
  };
  for (const [prototype, names] of [
    [HTMLImageElement.prototype, ['src', 'srcset']],
    [HTMLScriptElement.prototype, ['src']],
    [HTMLLinkElement.prototype, ['href']],
    [HTMLSourceElement.prototype, ['src', 'srcset']],
    [HTMLAnchorElement.prototype, ['href']],
    [HTMLVideoElement.prototype, ['poster', 'src']],
  ] as [object, string[]][])
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.set)
        Object.defineProperty(prototype, name, {
          ...descriptor,
          set(value: string) {
            descriptor.set!.call(
              this,
              name === 'srcset' ? mapSrcset(String(value), rewrite) : rewrite(String(value)),
            );
          },
        });
    }
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
  const adaptHTML = (value: string) => {
    const template = document.createElement('template');
    innerHTML.set!.call(template, value);
    for (const element of template.content.querySelectorAll(
      '[src],[href],[srcset],[poster],[action]',
    )) {
      for (const name of ['src', 'href', 'poster', 'action', 'srcset']) {
        const value = element.getAttribute(name);
        if (value !== null)
          attribute.call(
            element,
            name,
            name === 'srcset' ? mapSrcset(value, rewrite) : rewrite(value),
          );
      }
    }
    return innerHTML.get!.call(template) as string;
  };
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...innerHTML,
    set(value: string) {
      const html =
        this.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
        !['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE', 'XMP', 'PLAINTEXT', 'NOSCRIPT'].includes(
          this.tagName,
        );
      innerHTML.set!.call(this, html ? adaptHTML(String(value)) : value);
    },
  });
  const adjacent = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, value) {
    return adjacent.call(
      this,
      position,
      this.namespaceURI === 'http://www.w3.org/1999/xhtml' ? adaptHTML(value) : value,
    );
  };
}

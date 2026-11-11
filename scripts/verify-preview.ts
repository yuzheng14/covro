/** Real Chromium/Edge + real Vite/OS sockets; execution events are fixtures.
 * Does not start a Codex app-server, touch installed Covro, or configure any tunnel. */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { serve, upgradeWebSocket, type HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { chromium, expect } from '@playwright/test';
import { PreviewDiscovery } from '../src/server/preview/discovery.js';
import { PreviewProxy } from '../src/server/preview/proxy.js';
import { VitePreviewAdapter } from '../src/server/preview/vite.js';
import { attachPreviewWebSockets, guardPreviewUpgrades } from '../src/server/preview/websockets.js';
import { parseConfig } from '../src/server/config.js';
import { createAuthenticator } from '../src/server/auth.js';
import type { CodexClient, CodexEvent } from '../src/codex/types.js';
import { captureLogger } from '../tests/fixtures/logging.js';

const canonical = process.platform === 'win32' ? realpathSync.native : realpathSync;
const directory = canonical(await mkdtemp(join(tmpdir(), 'covro-preview-browser-')));
const children: ChildProcess[] = [];
const events = new Set<(event: CodexEvent) => void>();
const codex = {
  epoch: 'fixture-epoch',
  ready: true,
  pid: process.pid,
  onEvent: (fn: (event: CodexEvent) => void) => {
    events.add(fn);
    return () => {
      events.delete(fn);
    };
  },
} as CodexClient;
const projects = new Map<string, string>();
const logging = captureLogger();
const discovery = new PreviewDiscovery(
  codex,
  (thread, cwd) =>
    projects.get(thread) === cwd
      ? { projectId: thread, projectName: thread, canonicalCwd: cwd }
      : undefined,
  undefined,
  logging.logger,
);
const childrenInfo: { child: ChildProcess; cwd: string; thread: string; port: number }[] = [];
const report: Record<string, unknown> = {
  kind: 'real-browser-real-vite-real-os-fixture-executions',
  platform: process.platform,
};
const serverCleanup: (() => void)[] = [];
let proxy: PreviewProxy | undefined;
let server: ReturnType<typeof serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const failures: string[] = [];
const pageErrors: string[] = [];
let phase = 'strict-resources';
try {
  for (const tag of ['alpha', 'beta']) {
    const cwd = join(directory, tag);
    await mkdir(join(cwd, 'public'), { recursive: true });
    projects.set(tag, cwd);
    const font = process.env.PREVIEW_TEST_FONT ?? '/System/Library/Fonts/Supplemental/Arial.ttf';
    if (existsSync(font)) await copyFile(font, join(cwd, 'public', 'probe.ttf'));
    await writeFile(
      join(cwd, 'public', 'logo.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${tag === 'alpha' ? '#06b6d4' : '#a855f7'}"/></svg>`,
    );
    await writeFile(
      join(cwd, 'public', 'public.css'),
      `${existsSync(font) ? '@font-face{font-family:Probe;src:url(/probe.ttf)}' : ''}body{font-family:Probe,system-ui;background:#111827;color:white;padding:32px}h1{color:${tag === 'alpha' ? '#06b6d4' : '#a855f7'}}.logo{background:url('/logo.svg');width:64px;height:64px}`,
    );
    await writeFile(
      join(cwd, 'index.html'),
      `<html><head><title>${tag}</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/public.css"></head><body><h1>${tag}</h1><img id="logo" src="/logo.svg" srcset="/logo.svg 1x, /logo.svg 2x"><div class="logo"></div><a id="route" href="/deep/route">Deep route</a><p id="state"></p><p id="dynamic"></p><script type="module" src="/main.js"></script></body></html>`,
    );
    await writeFile(join(cwd, 'dynamic.js'), `export default '${tag}-dynamic'`);
    await writeFile(
      join(cwd, 'main.js'),
      `import {value} from '/value.js';const base=import.meta.env.BASE_URL;document.querySelector('#state').textContent=value+' '+location.pathname.slice(base.length);import('/dynamic.js').then(m=>document.querySelector('#dynamic').textContent=m.default);const runtime=document.createElement('div');runtime.innerHTML='<img id="runtime-logo" src="/logo.svg">';document.body.append(runtime);if(import.meta.hot)import.meta.hot.accept('/value.js',m=>document.querySelector('#state').textContent=m.value);`,
    );
    await writeFile(join(cwd, 'value.js'), `export const value='${tag}-initial'`);
    const child = fork(resolve('scripts/preview-probes/vite-child.ts'), [cwd, tag], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      cwd,
      env: { ...process.env, CODEX_THREAD_ID: tag, CODEX_TOOL_CALL_ID: `fixture-${tag}` },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stderr?.on('data', (b) => process.stderr.write(b));
    const [message] = (await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Vite fixture exited before listening');
      }),
    ])) as [{ port: number }];
    childrenInfo.push({ child, cwd, thread: tag, port: message.port });
    for (const fn of events)
      fn({
        type: 'previewExecution',
        threadId: tag,
        itemId: `fixture-${tag}`,
        cwd,
        command: `vite (${tag} fixture)`,
        source: 'agent',
      });
  }
  const config = parseConfig(
    {
      port: 18781,
      dataDir: directory,
      publicOrigin: [process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:18781'],
    },
    join(directory, 'config.json'),
  );
  const authenticate = createAuthenticator(config);
  proxy = new PreviewProxy(discovery, config, authenticate, new VitePreviewAdapter());
  await proxy.configure({ enabled: true, fullRequests: false });
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, 'status' in error ? (error.status as 400) : 500),
  );
  app.all('/preview/*', async (c, next) => {
    if (c.req.header('upgrade')) {
      const handler = await proxy!.websocket(c.req.raw, c.env.incoming);
      return upgradeWebSocket(() => handler)(c, next);
    }
    return proxy!.handle(c.req.raw);
  });
  app.get('/api/secret', async (c) => {
    await authenticate(c.req.raw);
    return c.json({ secret: 'management-fixture' });
  });
  const wss = new WebSocketServer({ noServer: true });
  const previewSockets = attachPreviewWebSockets(wss, proxy);
  serverCleanup.push(() => {
    previewSockets.forEach((sockets) => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    });
  });
  server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.port,
    websocket: { server: wss },
  });
  guardPreviewUpgrades(server, logging.logger);
  await once(server, 'listening');
  browser = await chromium.launch({ channel: process.env.PREVIEW_BROWSER_CHANNEL });
  report.browser = process.env.PREVIEW_BROWSER_CHANNEL ?? 'chromium';
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'management_dummy', value: 'never-upstream', url: config.publicOrigin[0]! },
  ]);
  const pages = [];
  const paths = [];
  const hmrConnections = [0, 0];
  for (const info of childrenInfo) {
    const services = (await discovery.snapshot(info.thread)).services;
    assert.equal(
      services.filter((s) => s.status === 'running').length,
      1,
      `discovery ${info.thread}`,
    );
    const { url } = await proxy.open(services.find((s) => s.status === 'running')!.id, {});
    paths.push(url);
    const page = await context.newPage();
    pages.push(page);
    const index = pages.length - 1;
    page.on('websocket', (socket) => {
      if (socket.url().includes('__vite_hmr'))
        hmrConnections[index] = (hmrConnections[index] ?? 0) + 1;
    });
    page.on('console', (message) => {
      if (message.type() === 'error')
        failures.push(message.text() + ' [' + message.location().url + ']');
    });
    page.on('pageerror', (error) => {
      pageErrors.push(`${phase}: ${error.message}`);
      console.error('Preview page error:', error.message);
    });
    await page.goto(config.publicOrigin[0] + url);
    await expect(page.locator('#state')).toContainText(`${info.thread}-initial`);
    await expect(page.locator('#dynamic')).toHaveText(`${info.thread}-dynamic`);
    assert.equal(
      await page.locator('#logo').evaluate((img) => (img as HTMLImageElement).naturalWidth),
      64,
    );
    await expect
      .poll(() =>
        page.locator('#runtime-logo').evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(64);
    assert.equal(
      await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('16px Probe');
      }),
      true,
    );
    assert.equal(
      await page.evaluate(() => {
        try {
          return document.cookie.includes('management_dummy');
        } catch {
          return false;
        }
      }),
      false,
    );
    assert.equal(
      await page.evaluate(() => {
        try {
          indexedDB.open('management');
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.equal(
      await page.evaluate(() => {
        try {
          localStorage.getItem('management');
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.equal(
      await page.evaluate(async () => {
        try {
          await fetch('/api/secret');
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.equal(
      await page.evaluate(async (origin) => {
        try {
          await fetch(origin + '/api/secret');
          return false;
        } catch {
          return true;
        }
      }, config.publicOrigin[0]!),
      true,
    );
    await page.locator('#route').click();
    await expect(page).toHaveURL(new RegExp(url + 'deep/route$'));
    await page.reload();
    await expect(page.locator('#state')).toContainText('deep/route');
    await page.evaluate(() => history.pushState({}, '', '/client/route'));
    await expect(page).toHaveURL(new RegExp(url + 'client/route$'));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(url + 'deep/route$'));
    assert.equal(
      await page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket('/business-ws');
            socket.onopen = () => {
              socket.close();
              resolve(false);
            };
            socket.onerror = () => resolve(true);
          }),
      ),
      true,
    );
    if (process.env.PREVIEW_SCREENSHOTS) {
      await mkdir(process.env.PREVIEW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.PREVIEW_SCREENSHOTS, `${info.thread}.png`) });
    }
  }
  report.resourcesRoutingIsolation = 'passed';
  await writeFile(join(childrenInfo[0]!.cwd, 'value.js'), "export const value='alpha-hmr'");
  await expect(pages[0]!.locator('#state')).toHaveText('alpha-hmr', { timeout: 15_000 });
  await expect(pages[1]!.locator('#state')).toContainText('beta-initial');
  report.twoProjectHmr = 'passed';
  const previous = hmrConnections[0]!;
  childrenInfo[0]!.child.send('disconnect-hmr');
  await expect.poll(() => hmrConnections[0]!, { timeout: 15_000 }).toBeGreaterThan(previous);
  await writeFile(join(childrenInfo[0]!.cwd, 'value.js'), "export const value='alpha-reconnected'");
  await expect(pages[0]!.locator('#state')).toContainText('alpha-reconnected', { timeout: 15_000 });
  report.hmrReconnect = 'passed';
  for (const current of pages) await expect(current.locator('#dynamic')).toContainText('-dynamic');
  phase = 'enable-full';
  await proxy.configure({ enabled: true, fullRequests: true });
  const service = (await discovery.snapshot('alpha')).services.find((s) => s.status === 'running')!;
  const full = await proxy.open(service.id, {});
  const page = pages[0]!;
  await page.goto(config.publicOrigin[0] + full.url);
  await expect(page.locator('#dynamic')).toHaveText('alpha-dynamic');
  const business = await page.evaluate(async () => {
    const result = await (
      await fetch('/api', {
        method: 'POST',
        headers: {
          authorization: 'Bearer application-fixture',
          'content-type': 'application/json',
        },
        body: '{"test":true}',
      })
    ).json();
    const echo = await new Promise((resolve, reject) => {
      const ws = new WebSocket('/business-ws');
      ws.onopen = () => ws.send('business-fixture');
      ws.onmessage = (event) => {
        ws.close();
        resolve(event.data);
      };
      ws.onerror = reject;
    });
    return { result, echo };
  });
  assert.equal(business.result.credentials, false);
  assert.equal(business.result.applicationAuthorization, 'Bearer application-fixture');
  assert.equal(business.result.method, 'POST');
  assert.equal(business.echo, 'business-fixture');
  const skipSse = process.env.PREVIEW_SKIP_SSE;
  await page.evaluate(async (skipSse) => {
    const probe = window as unknown as {
      probeSocket: WebSocket;
      probeEvents: EventSource;
      probeCount: number;
      probeFailed: boolean;
    };
    probe.probeSocket = new WebSocket('/business-ws');
    await new Promise<void>((resolve) => {
      probe.probeSocket.onopen = () => resolve();
    });
    if (skipSse) return;
    probe.probeEvents = new EventSource('/events');
    probe.probeCount = 0;
    probe.probeFailed = false;
    probe.probeEvents.onmessage = () => probe.probeCount++;
    probe.probeEvents.onerror = () => {
      probe.probeFailed = true;
      probe.probeEvents.close();
    };
  }, skipSse);
  if (!skipSse)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { probeCount: number }).probeCount))
      .toBeGreaterThan(1);
  await proxy.configure({ enabled: true, fullRequests: false });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { probeSocket: WebSocket }).probeSocket.readyState),
    )
    .toBe(3);
  if (!skipSse)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { probeFailed: boolean }).probeFailed))
      .toBe(true);
  report.sse = skipSse ? `not exercised: ${skipSse}` : 'stream and revocation passed';
  assert.equal((await fetch(config.publicOrigin[0] + full.url)).status, 410);
  await proxy.configure({ enabled: false, fullRequests: true });
  assert.equal(proxy.configuration().fullRequests, false);
  report.fullRequestsAndRevocation = 'passed';
  assert.deepEqual(pageErrors, []);
  const unexpected = failures.filter(
    (message) =>
      !/\b(?:403|410)\b|__covro_request|\/api\/secret|\/business-ws|\/events/.test(message),
  );
  assert.deepEqual(unexpected, [], 'Unexpected browser console errors');
  report.expectedDenialsAndRevocations = failures.length;
  report.unexpectedBrowserErrors = pageErrors.length + unexpected.length;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ phase: 'probe-failed', discovery: logging.records }, null, 2));
  console.error(
    JSON.stringify({
      phase,
      completed: report,
      browserErrors: pageErrors.length,
      failedRequests: failures.length,
    }),
  );
  throw error;
} finally {
  await browser?.close();
  proxy?.close();
  discovery.close();
  serverCleanup.forEach((close) => close());
  if (server) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  }
  for (const child of children) {
    if (child.connected) child.send('close');
  }
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null) {
        const timer = setTimeout(() => child.kill(), 3000);
        await once(child, 'exit');
        clearTimeout(timer);
      }
    }),
  );
  await rm(directory, { recursive: true, force: true });
}

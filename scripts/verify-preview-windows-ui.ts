/** Real Windows/Edge UI, with explicit execution fixtures; no Codex CLI is started. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

assert.equal(process.platform, 'win32');
const env = { ...process.env, E2E_PORT: '18888', PREVIEW_BROWSER_CHANNEL: 'msedge' };
const host = fork(resolve('scripts/test-server.ts'), [], {
  env,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && host.exitCode === null; attempt++) {
    ready = await fetch('http://127.0.0.1:18888')
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'The isolated Windows fixture gateway must become ready');
  const browser = fork(resolve('scripts/verify-preview-ui.ts'), [], {
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [code] = await once(browser, 'exit');
  assert.equal(code, 0, 'Real Windows Edge UI verification must pass');
} finally {
  if (host.exitCode === null) {
    const exited = once(host, 'exit');
    if (host.connected) host.send('close');
    const timer = setTimeout(() => host.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

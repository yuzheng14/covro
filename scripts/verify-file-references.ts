/** Explicit native acceptance; uses one isolated CLI/home and a fresh disposable gateway. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { CodexAdapter } from '../src/codex/adapter.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';

const args = process.argv.slice(2);
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  covroCodex: { recommended: string };
};
assert(args.includes('--inference'), 'Pass --inference to authorize isolated native acceptance');
const binaryIndex = args.indexOf('--binary');
const outputIndex = args.indexOf('--output-dir');
assert(binaryIndex >= 0 && outputIndex >= 0, 'Pass --binary and --output-dir');
const output = resolve(args[outputIndex + 1]!);
await mkdir(output, { recursive: true });
await rm(join(output, 'native-file-reference-results.json'), { force: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'covro-native-files-')));
await chmod(root, 0o700);
const home = join(root, 'home');
const project = join(root, 'project');
await mkdir(home, { mode: 0o700 });
await mkdir(join(project, 'docs'), { recursive: true });
await mkdir(join(project, 'a'));
await mkdir(join(project, 'b'));
const path = 'docs/中文 说明.txt';
const first = `FILE_A_${randomUUID()}`;
const second = `FILE_B_${randomUUID()}`;
await writeFile(join(project, path), first + '\n');
await writeFile(join(project, 'a/same.txt'), second + '\n');
await writeFile(join(project, 'b/same.txt'), 'WRONG_SAME_NAME_FILE\n');
await mkdir(join(project, 'stress'));
await Promise.all(
  Array.from({ length: 300 }, (_, index) =>
    writeFile(join(project, 'stress', `match-${index}.txt`), 'bounded search\n'),
  ),
);
// Reuse only the existing authentication. No global history, configuration, MCP or skills.
await copyFile(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'));
await chmod(join(home, 'auth.json'), 0o600);
await writeFile(
  join(home, 'config.toml'),
  'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n',
);
const port = 8918;
const origin = `http://127.0.0.1:${port}`;
const config = parseConfig(
  {
    port,
    publicOrigin: [origin],
    dataDir: join(root, 'data'),
    codex: { binary: resolve(args[binaryIndex + 1]!), home },
    projects: [{ id: 'native-files', name: '原生文件引用验收', path: project }],
  },
  join(root, 'config.json'),
);
const codex = new CodexAdapter(config.codex);
const report = {
  date: new Date().toISOString(),
  version: '',
  simulated: false,
  inference: true,
  checks: [] as string[],
};
let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let pendingApproval = false;
const unsubscribe = codex.onEvent((event) => {
  if (event.type === 'action' && event.action.status === 'pending') pendingApproval = true;
});
try {
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
  report.version = codex.diagnostics().codexVersion!;
  assert.equal(report.version, manifest.covroCodex.recommended);
  assert.equal(codex.diagnostics().compatibility, 'verified');
  const pid = codex.pid;
  const query = await codex.searchFiles(project, '中文 说', new AbortController().signal);
  assert(query.files.some((file) => file.path === path));
  const limited = await codex.searchFiles(project, 'match-', new AbortController().signal);
  assert.equal(limited.files.length, 50);
  const controller = new AbortController();
  const cancelled = codex.searchFiles(project, 'match-', controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert(
    (await codex.searchFiles(project, 'a/same', new AbortController().signal)).files.some(
      (file) => file.path === 'a/same.txt',
    ),
  );
  assert.equal(codex.pid, pid);
  report.checks.push(
    'native Chinese/space fuzzy search',
    'native 50-result cap',
    'cancel followed by a successful query on the same app-server',
  );
  const draftId = randomUUID();
  const unassigned = await runtime.service.searchFiles(
    { projectId: null, draftId, query: '' },
    new AbortController().signal,
  );
  assert(unassigned.cwd.startsWith(root + '/'));
  await writeFile(join(unassigned.cwd, 'unassigned-probe.txt'), 'native unassigned probe\n');
  const reserved = await runtime.service.searchFiles(
    { projectId: null, draftId, query: 'unassigned-probe' },
    new AbortController().signal,
  );
  assert.deepEqual(reserved.paths, ['unassigned-probe.txt']);
  const created = await runtime.service.createThread(null, { clientOperationId: draftId });
  assert.equal(created.status, 'acknowledged');
  const unassignedId = (created.result as { threadId: string }).threadId;
  const bound = await runtime.service.searchFiles(
    { projectId: null, threadId: unassignedId, query: 'unassigned-probe' },
    new AbortController().signal,
  );
  assert.equal(bound.cwd, unassigned.cwd);
  assert.deepEqual(bound.paths, reserved.paths);
  report.checks.push(
    'native unassigned draft search and session creation reuse the exact reserved cwd',
  );
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await page.goto(origin);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  const input = page.locator('.composer-editor textarea');
  await input.fill(
    'Read exactly these two referenced files and return both tokens on one line. Do not modify files, read unrelated files, or use the network: ',
  );
  await input.pressSequentially('@"docs/中文 ');
  await page
    .locator('.file-reference-menu')
    .getByRole('option', { name: path, exact: false })
    .click();
  await input.pressSequentially('@a/same');
  await page
    .locator('.file-reference-menu')
    .getByRole('option', { name: 'a/same.txt', exact: false })
    .click();
  await expect(page.locator('mark[data-file-path]')).toHaveCount(2);
  const draft = await input.inputValue();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await expect(page.locator('.sidebar')).not.toBeInViewport();
    await page.screenshot({
      path: join(output, `native-files-selected-${width}.png`),
      animations: 'disabled',
    });
  }
  await rm(join(project, path));
  await page.locator('.composer-submit button').click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文件已移动或删除' }).first(),
  ).toBeVisible();
  await expect(input).toHaveValue(draft);
  await expect(page.locator('mark[data-file-path]')).toHaveCount(2);
  report.checks.push('actual deletion rejected before dispatch with the bound draft retained');
  await writeFile(join(project, path), first + '\n');
  const sending = page.waitForRequest(
    (request) => request.method() === 'POST' && /\/threads\/[^/]+\/turns$/u.test(request.url()),
  );
  await page.locator('.composer-submit button').click();
  const sent = await sending;
  assert.equal(sent.postDataJSON().files.length, 2);
  await expect(input).toHaveValue('');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成', {
    timeout: 180000,
  });
  assert(!pendingApproval, 'Unexpected human approval; no automatic approval is permitted');
  const response = await page.locator('.assistant-message .markdown').last().textContent();
  assert(response, 'Actual reply must be present');
  assert(
    response.includes(first) && response.includes(second),
    'Actual reply must contain both hidden file tokens',
  );
  assert(!response.includes('WRONG_SAME_NAME_FILE'));
  // Main retains the failed attempt as its own bubble. Inspect native history directly,
  // rather than confusing that preserved failed draft with the accepted native message.
  const threadId = new URL(sent.url()).pathname.split('/')[3]!;
  const history = await codex.readThread(threadId);
  const nativeMessages = history.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage');
  assert.equal(nativeMessages.length, 1);
  assert(nativeMessages[0]!.text?.includes('"docs/中文 说明.txt" a/same.txt'));
  assert(!nativeMessages[0]!.text?.includes('@"docs/中文'));
  report.checks.push(
    'production browser -> gateway -> native turn/start',
    'actual model reads Chinese/space path and exact same-name file',
    'native history contains quoted path text',
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.assistant-message .markdown').last()).toBeVisible();
    await page.screenshot({
      path: join(output, `native-files-result-${width}.png`),
      animations: 'disabled',
    });
  }
  await writeFile(
    join(output, 'native-file-reference-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  unsubscribe();
  await browser?.close();
  await runtime?.close();
  if (!runtime) await codex.stop();
  await rm(root, { recursive: true, force: true });
}

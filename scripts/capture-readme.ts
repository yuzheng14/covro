/** Capture the real app with explicit sample history. No account or model requests. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { CodexAdapter } from '../src/codex/adapter.js';
import type { Thread } from '../src/codex/generated/v2/Thread.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';

const root = await mkdtemp(join(tmpdir(), 'covro-showcase-'));
const project = join(root, 'website');
const other = join(root, 'api');
const assets = resolve(process.env.COVRO_SCREENSHOTS ?? 'docs/assets');
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('Expected local port');
await new Promise<void>((done) => probe.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
await mkdir(join(project, 'docs'), { recursive: true });
await mkdir(other);
await mkdir(assets, { recursive: true });
const now = Math.floor(Date.now() / 1000);
function conversation(cwd: string, name: string, prompt: string, response: string): Thread {
  const id = randomUUID();
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: prompt,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'legacy',
    modelProvider: 'openai',
    model: 'sample-model',
    reasoningEffort: 'medium',
    createdAt: now - 600,
    updatedAt: now - 60,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.163.0',
    originator: 'codex_web_ui',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name,
    turns: [
      {
        id: randomUUID(),
        rootTurnId: null,
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: now - 68,
        completedAt: now - 60,
        durationMs: 8000,
        items: [
          {
            id: randomUUID(),
            type: 'userMessage',
            clientId: null,
            content: [{ type: 'text', text: prompt, text_elements: [] }],
          },
          {
            id: randomUUID(),
            type: 'agentMessage',
            moderation: null,
            phase: 'final_answer',
            memoryCitation: null,
            delivery: null,
            questions: null,
            text: response,
          },
        ],
      },
    ],
  };
}
const main = conversation(
  project,
  'Website launch',
  'Review the website launch and prepare a release checklist. Keep the mobile experience in scope.',
  "## Ready for the next step\n\nI've organized the launch work into three small steps.\n\n" +
    '- **Interface:** check navigation, conversation layout, and the mobile reader.\n' +
    '- **Behavior:** walk through a task, review its result, and continue the conversation.\n' +
    '- **Delivery:** run the checks and document how to install and update.\n\n' +
    '[Open the release checklist](docs/release-checklist.md) to read the plan beside this conversation.\n\n' +
    "```sh\npnpm typecheck\npnpm test\npnpm build\n```\n\nTell me which part you'd like to tackle next.",
);
await writeFile(
  join(project, 'docs/release-checklist.md'),
  '# Release checklist\n\nA short plan for the next iteration. Keep each change easy to review.\n\n' +
    '## 1. Walk through the experience\n\n' +
    '| Surface | What to check |\n| --- | --- |\n| Desktop | Projects, conversations, and side-by-side reading |\n' +
    '| Mobile | Navigation, approvals, and the composer |\n| Reconnect | Return to the same conversation |\n\n' +
    '## 2. Keep the work focused\n\n- [ ] Review one feature at a time.\n- [ ] Check both screen sizes.\n- [ ] Keep English and Chinese instructions in sync.\n\n' +
    '## 3. Prepare delivery\n\n```sh\npnpm typecheck\npnpm lint\npnpm test\npnpm build\n```\n\n' +
    '> Start at your desk. Follow the result from your phone.\n',
);
const historyPath = join(root, 'history.json');
await writeFile(
  historyPath,
  JSON.stringify({
    threads: [
      main,
      conversation(
        project,
        'Mobile navigation',
        'Make the navigation comfortable on a phone.',
        'Keep the current conversation visible and make the project list easy to open.',
      ),
      conversation(
        other,
        'API request validation',
        'Plan the API validation work.',
        'Validate inputs before dispatching work, and keep error responses actionable.',
      ),
    ],
    archived: [],
  }),
);
const config = parseConfig(
  {
    port: address.port,
    publicOrigin: [origin],
    dataDir: join(root, 'data'),
    projects: [
      { id: 'website', name: 'Website', path: project },
      { id: 'api', name: 'Orbit API', path: other },
    ],
  },
  join(root, 'config.json'),
);
config.demo = true;
const codex = new CodexAdapter({
  binary: resolve('tests/fixtures/codex.mjs'),
  args: ['--options', JSON.stringify({ historyPath, models: ['sample-model'] })],
});
const runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(origin);
  await page.locator(`[data-thread-id="${main.id}"]`).click();
  const link = page.getByRole('link', { name: 'Open the release checklist', exact: true });
  await expect(link).toBeVisible();
  await link.click();
  const preview = page.getByRole('dialog', { name: 'Markdown 文件预览', exact: true });
  await expect(
    preview.getByRole('heading', { name: 'Release checklist', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(assets, 'workspace-desktop.png'), animations: 'disabled' });
  await preview.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('heading', { name: 'Ready for the next step', exact: true })
    .scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(assets, 'workspace-mobile.png'), animations: 'disabled' });
  console.log('Captured desktop and mobile from the running gateway with explicit sample history.');
} finally {
  await browser?.close();
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}

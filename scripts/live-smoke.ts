/** Explicit real-Codex check. Inference requires --inference and only touches a fresh temporary project. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter, type AdapterEvent } from '../src/codex/adapter.js';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const configIndex = args.indexOf('--config');
const configPath = resolve(configIndex < 0 ? 'config.local.json' : args[configIndex + 1]!);
let codex: { binary: string; home?: string } = { binary: 'codex' };
try {
  codex = {
    ...codex,
    ...(JSON.parse(await readFile(configPath, 'utf8')) as { codex: typeof codex }).codex,
  };
} catch (error) {
  if (configIndex >= 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const adapter = new CodexAdapter(codex);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  inference: args.includes('--inference'),
  checks: [],
};
const checks = report.checks as string[];
let project: string | undefined;
let currentThread: string | undefined;
let currentTurn: string | undefined;
let failure: unknown;
try {
  await adapter.start();
  const system = adapter.diagnostics();
  report.codexVersion = system.codexVersion;
  report.compatibility = system.compatibility;
  report.authenticated = system.authenticated;
  report.modelCount = system.models.length;
  checks.push(
    'actual binary version',
    'initialize -> initialized handshake',
    'account/read (no credentials printed)',
    'model/list',
  );
  if (args.includes('--inference')) {
    if (!system.authenticated)
      throw new Error(
        'Codex authentication is unavailable; no login or account changes were attempted',
      );
    project = await mkdtemp(join(tmpdir(), 'codex-web-live-'));
    report.project = project;
    const thread = await adapter.createThread(project, {
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    currentThread = thread.id;
    report.threadId = thread.id;
    const events: AdapterEvent[] = [];
    let unsubscribe = adapter.onEvent((event) => events.push(event));
    const initialPid = adapter.pid;
    const turn = await adapter.startTurn(
      thread.id,
      project,
      'This is an isolated smoke test. Use apply_patch to create only smoke.txt in the current directory containing exactly Codex Web UI smoke test followed by one newline. Do not read unrelated files or directories, do not access the network, and do not start background processes. Then reply with a short confirmation.',
      { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    );
    currentTurn = turn.id;
    unsubscribe(); // Browser subscriptions are independent of the owned app-server lifetime.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (adapter.pid !== initialPid)
      throw new Error('app-server changed when no event subscribers were present');
    unsubscribe = adapter.onEvent((event) => events.push(event));
    const deadline = Date.now() + 180_000;
    async function awaitTurn(turnId: string, recoverCompletedHistory = false): Promise<void> {
      while (Date.now() < deadline) {
        if (!adapter.ready) throw new Error(adapter.diagnostics().error ?? 'Codex disconnected');
        const action = events.find(
          (event) => event.type === 'action' && event.action.status === 'pending',
        );
        if (action)
          throw new Error(
            'The smoke task needs a human decision. Use the Web UI to exercise this approval; this script does not auto-approve.',
          );
        const terminal = events.find(
          (event) =>
            event.type === 'turn' &&
            event.turn.id === turnId &&
            ['completed', 'interrupted', 'failed'].includes(event.turn.status),
        );
        // A just-started turn's persisted history can still look interrupted. Use the
        // live terminal receipt; only recover completed history across the deliberate
        // subscription gap above, where the completion notification may be missed.
        const completed =
          terminal?.type === 'turn'
            ? terminal.turn
            : recoverCompletedHistory
              ? (await adapter.readThread(thread.id)).turns.find(
                  (candidate) => candidate.id === turnId && candidate.status === 'completed',
                )
              : undefined;
        if (completed && ['completed', 'interrupted', 'failed'].includes(completed.status)) {
          if (completed.status !== 'completed')
            throw new Error(`Turn ended ${completed.status}: ${completed.error ?? ''}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('Inference smoke test exceeded 180 seconds');
    }
    await awaitTurn(turn.id, true);
    const content = await readFile(join(project, 'smoke.txt'), 'utf8');
    if (content !== 'Codex Web UI smoke test\n')
      throw new Error('The real file content does not match the requested isolated task');
    const history = await adapter.readThread(thread.id);
    const first = history.turns.find((candidate) => candidate.id === turn.id)!;
    report.fileChangeObserved =
      first.items.some((item) => Boolean(item.changes?.length)) ||
      events.some(
        (event) => event.type === 'diff' && event.turnId === turn.id && event.diff.length > 0,
      );
    report.commandOutputObserved = first.items.some((item) => Boolean(item.output));
    checks.push(
      'thread/start',
      'turn/start and completed history',
      'verified real temporary file content',
      'unchanged child PID while event subscription absent',
      'history restored after resubscribe',
    );
    const next = await adapter.startTurn(
      thread.id,
      project,
      'Continue this conversation: reply with exactly SMOKE_CONTINUED. Do not call tools or change files.',
    );
    currentTurn = next.id;
    await awaitTurn(next.id);
    checks.push('continued conversation turn');
    const page = await adapter.listThreads(project);
    if (!page.data.some((item) => item.id === thread.id))
      throw new Error('Created app-server thread missing from explicit sourceKinds history');
    checks.push('thread/list includes created appServer history');
    unsubscribe();
    report.browserAndTunnel =
      'Not exercised by this adapter smoke; use browser and deployed-origin checks separately';
  } else
    report.inferenceSkipped =
      'Pass --inference to explicitly use Codex quota for the isolated file task';
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
  if (currentThread && currentTurn && adapter.ready)
    await adapter.interruptTurn(currentThread, currentTurn).catch(() => {});
} finally {
  await adapter.stop();
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0)
    await writeFile(resolve(args[outputIndex + 1]!), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (failure) process.exitCode = 1;

/** A small process guardian: losing the server IPC connection stops Git, including
 * on abrupt server termination. It never registers projects or resumes a clone.
 */
import { spawn } from 'node:child_process';
let child: ReturnType<typeof spawn> | undefined;
let stopping = false;
let finished = false;
let escalation: ReturnType<typeof setTimeout> | undefined;
function signal(signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* Git has already exited. */
  }
}
function stop() {
  if (finished) return;
  if (!child) process.exit(0);
  stopping = true;
  signal('SIGTERM');
  escalation ??= setTimeout(() => signal('SIGKILL'), 3000);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (message: { type: string; args?: string[]; env?: NodeJS.ProcessEnv }) => {
  if (message.type === 'cancel') return stop();
  if (message.type !== 'start' || child || stopping) return;
  child = spawn('git', message.args!, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'inherit', 'inherit'],
    env: message.env,
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (process.connected)
      process.send?.({ type: 'error', missingGit: error.code === 'ENOENT' }, () => {});
  });
  child.on('close', (code) => {
    finished = true;
    clearTimeout(escalation);
    if (process.connected) {
      process.send?.({ type: 'exit', code }, () => {});
      process.disconnect();
    }
    process.exitCode = 0;
  });
});

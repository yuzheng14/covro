import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const options = { encoding: 'utf8' as const, timeout: 3000, maxBuffer: 8 * 1024 * 1024 };
export interface ProcessIdentity {
  pid: number;
  parent: number;
  birth: string;
  cwd: string;
  thread?: string;
  call?: string;
}
export interface Listener {
  pid: number;
  port: number;
  host: '127.0.0.1' | '::1';
}
export interface ProcessSnapshot {
  processes: Map<number, ProcessIdentity>;
  listeners: Listener[];
}
export interface ProcessInspector {
  snapshot(root: number): Promise<ProcessSnapshot>;
  connected(pid: number, port: number, clientPort: number): Promise<boolean>;
}
const descendant = (pid: number, root: number, parents: Map<number, { parent: number }>) => {
  const visited = new Set<number>();
  while (pid > 0 && !visited.has(pid)) {
    if (pid === root) return true;
    visited.add(pid);
    pid = parents.get(pid)?.parent ?? 0;
  }
  return false;
};
const darwinProbe = fileURLToPath(new URL('../../../bin/process-darwin.js', import.meta.url));
/** The system JXA runtime executes our JS source using public macOS APIs.
 * No shipped binary, compiler, Python, Node addon or downloaded runtime. */
class DarwinInspector implements ProcessInspector {
  private async table(root: number) {
    const { stdout } = await execute(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', darwinProbe, 'table', String(root)],
      options,
    ).catch((error: Error) => {
      error.name = 'PreviewProcessTableError';
      throw error;
    });
    const rows = new Map<number, { parent: number; birth: string }>();
    for (const entry of JSON.parse(stdout) as { pid: number; parent: number; birth: string }[])
      rows.set(entry.pid, entry);
    if (!rows.has(root)) throw new Error('App-server identity is unavailable');
    return rows;
  }
  async snapshot(root: number): Promise<ProcessSnapshot> {
    const before = await this.table(root);
    // Restrict lsof to this app-server's descendants. A system-wide socket scan
    // needlessly inspects unrelated services and can exceed the bounded timeout.
    const candidates = [...before.keys()].filter(
      (pid) => pid !== root && descendant(pid, root, before),
    );
    if (candidates.length > 8192) throw new Error('Too many descendant processes to inspect');
    const { stdout: sockets } = candidates.length
      ? await execute(
          '/usr/sbin/lsof',
          ['-nP', '-a', '-p', candidates.join(','), '-iTCP', '-sTCP:LISTEN', '-F0pn'],
          options,
        ).catch((error: { code?: number; stdout?: string }) => {
          // lsof exits 1 when any selected PID has already exited (including the
          // short-lived table probe). Its positive socket records remain usable;
          // missing records are never evidence of ownership and withdraw that run.
          if (error.code === 1) return { stdout: error.stdout ?? '' };
          (error as Error).name = 'PreviewListenerInspectionError';
          throw error;
        })
      : { stdout: '' };
    const listeners: Listener[] = [];
    let pid = 0;
    for (const field of sockets.split(/[\0\n]/)) {
      if (field.startsWith('p')) pid = Number(field.slice(1));
      if (!field.startsWith('n') || pid === root || !descendant(pid, root, before)) continue;
      const match = /^n(127\.0\.0\.1|\[::1\]|\*):(\d+)$/.exec(field);
      if (match)
        listeners.push({
          pid,
          port: Number(match[2]),
          host: match[1] === '[::1]' ? '::1' : '127.0.0.1',
        });
    }
    const processes = new Map<number, ProcessIdentity>();
    // One source-only helper process for all candidates, with bounded output.
    const ids = [...new Set(listeners.map((listener) => listener.pid))];
    if (ids.length > 256) throw new Error('Too many listener candidates to inspect');
    if (ids.length) {
      const { stdout } = await execute(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', darwinProbe, 'identities', ids.join(',')],
        options,
      );
      for (const identity of JSON.parse(stdout) as ProcessIdentity[]) {
        if (
          ids.includes(identity.pid) &&
          identity.birth === before.get(identity.pid)?.birth &&
          identity.cwd.startsWith('/')
        )
          processes.set(identity.pid, identity);
      }
    }
    const after = await this.table(root);
    for (const [id, identity] of processes)
      if (after.get(id)?.birth !== identity.birth || !descendant(id, root, after))
        processes.delete(id);
    if (before.get(root)?.birth !== after.get(root)?.birth)
      throw new Error('App-server identity changed');
    return { processes, listeners: listeners.filter((l) => processes.has(l.pid)) };
  }
  async connected(pid: number, port: number, clientPort: number) {
    const { stdout } = await execute(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED', '-Fn'],
      options,
    );
    return stdout
      .split('\n')
      .some(
        (line) =>
          line === `n127.0.0.1:${port}->127.0.0.1:${clientPort}` ||
          line === `n[::1]:${port}->[::1]:${clientPort}`,
      );
  }
}

/** Linux uses kernel start ticks, NUL-separated environment, and socket inodes. */
class LinuxInspector implements ProcessInspector {
  private async identity(pid: number) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { parent: Number(fields[1]), birth: fields[19]! };
  }
  private async sockets(pid: number) {
    if ((await readlink(`/proc/${pid}/ns/net`)) !== (await readlink('/proc/self/ns/net')))
      return [];
    const inodes = new Set<string>();
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match) inodes.add(match[1]!);
    }
    const rows: {
      port: number;
      remote: number;
      remoteLoopback: boolean;
      state: string;
      host: Listener['host'];
    }[] = [];
    for (const version of ['tcp', 'tcp6']) {
      const table = await readFile(`/proc/${pid}/net/${version}`, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (version === 'tcp6' && error.code === 'ENOENT') return '';
          throw error;
        },
      );
      for (const line of table.trim().split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (!inodes.has(f[9]!)) continue;
        const [address, port] = f[1]!.split(':');
        if (
          ![
            '0100007F',
            '00000000',
            '00000000000000000000000001000000',
            '00000000000000000000000000000000',
          ].includes(address!)
        )
          continue;
        rows.push({
          port: parseInt(port!, 16),
          remote: parseInt(f[2]!.split(':')[1]!, 16),
          remoteLoopback: ['0100007F', '00000000000000000000000001000000'].includes(
            f[2]!.split(':')[0]!,
          ),
          state: f[3]!,
          host: version === 'tcp' ? '127.0.0.1' : '::1',
        });
      }
    }
    return rows;
  }
  async snapshot(root: number): Promise<ProcessSnapshot> {
    const parents = new Map<number, { parent: number; birth: string }>();
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const entry = await this.identity(Number(name)).catch(() => undefined);
      if (entry) parents.set(Number(name), entry);
    }
    const processes = new Map<number, ProcessIdentity>();
    const listeners: Listener[] = [];
    for (const [pid, identity] of parents) {
      if (pid === root || !descendant(pid, root, parents)) continue;
      try {
        const sockets = (await this.sockets(pid)).filter((s) => s.state === '0A');
        if (!sockets.length) continue;
        const entries = (await readFile(`/proc/${pid}/environ`, 'utf8'))
          .split('\0')
          .map((s): [string, string] => {
            const index = s.indexOf('=');
            return [s.slice(0, index), s.slice(index + 1)];
          });
        const env = new Map(entries);
        if (
          ['CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID'].some(
            (key) =>
              entries.filter(([name]) => name === key).length !== 1 ||
              !/^[a-zA-Z0-9_-]{1,160}$/.test(env.get(key) ?? ''),
          )
        )
          continue;
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if ((await this.identity(pid)).birth !== identity.birth) continue;
        processes.set(pid, {
          pid,
          ...identity,
          cwd,
          thread: env.get('CODEX_THREAD_ID'),
          call: env.get('CODEX_TOOL_CALL_ID'),
        });
        listeners.push(...sockets.map(({ port, host }) => ({ pid, port, host })));
      } catch {
        /* Exiting or inaccessible processes cannot be registered. */
      }
    }
    if ((await this.identity(root)).birth !== parents.get(root)?.birth)
      throw new Error('App-server identity changed');
    return { processes, listeners };
  }
  async connected(pid: number, port: number, clientPort: number) {
    return (await this.sockets(pid)).some(
      (s) => s.state === '01' && s.port === port && s.remote === clientPort && s.remoteLoopback,
    );
  }
}
export function systemInspector(): ProcessInspector | undefined {
  if (process.platform === 'darwin' && existsSync('/usr/bin/osascript') && existsSync(darwinProbe))
    return new DarwinInspector();
  if (process.platform === 'linux') return new LinuxInspector();
  return undefined;
}

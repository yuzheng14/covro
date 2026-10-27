import { backupDirectory } from '../src/backups/store.js';
import { npmPackageName } from '../src/shared/package.js';
import { CODEX_COMPATIBILITY } from '../src/codex/compatibility.js';
/** Real daemon/worker/SQLite verification; npm transport is an explicit local fixture. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { control, stopAndWait } from '../src/cli/control.js';
import { stopBackground } from '../src/cli/background.js';
import { paths } from '../src/cli/paths.js';
import { saveJson } from '../src/updates/files.js';
import type { UpdateRun } from '../src/shared/updates.js';
import { transactionPaths } from '../src/updates/transaction.js';
const metadata = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const [major, minor, patch] = metadata.version.split('-')[0]!.split('.');

for (const mode of [
  'success',
  'stable-beta',
  'stable-dev',
  'commit-mismatch',
  'failure',
  'repair',
  'repair-live',
  'repair-resumed',
  'codex-mismatch',
  'codex-missing',
  'codex-changed',
  'codex-unverified',
  'codex-confirmed',
  'codex-unsupported',
  'codex-unavailable',
  'codex-restarted',
] as const) {
  const failure = ['failure', 'repair', 'repair-live', 'repair-resumed'].includes(mode);
  const rolledBack = failure || mode === 'codex-restarted';
  const rejected =
    mode === 'commit-mismatch' ||
    (mode.startsWith('codex-') && !['codex-confirmed', 'codex-restarted'].includes(mode));
  const repair = mode.startsWith('repair');
  const directory = await mkdtemp('/private/tmp/covro-verify-').catch(async () => {
    const { tmpdir } = await import('node:os');
    return mkdtemp(join(tmpdir(), 'cv-'));
  });
  const root = join(directory, 'npm/lib/node_modules', npmPackageName);
  const home = join(directory, 'home');
  const config = join(directory, 'config.json');
  const priorHome = process.env.COVRO_HOME;
  process.env.COVRO_HOME = home;
  const location = paths(config);
  process.env.COVRO_HOME = priorHome;
  if (priorHome === undefined) delete process.env.COVRO_HOME;
  let child: ReturnType<typeof spawn> | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  const candidate = join(directory, 'candidate');
  const stableCandidate = mode.startsWith('stable-');
  const subscription = mode === 'stable-beta' ? 'beta' : 'dev';
  const target = `${major}.${minor}.${BigInt(patch!) + 1n}${stableCandidate ? '' : `-dev.${failure ? 2 : 1}`}`;
  try {
    await mkdir(root, { recursive: true });
    for (const entry of ['bin', 'dist', 'package.json'])
      await cp(resolve(entry), join(root, entry), { recursive: true });
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    await mkdir(join(directory, 'npm/bin'), { recursive: true });
    await symlink(join(root, 'bin/covro.mjs'), join(directory, 'npm/bin/covro'));
    await cp(root, candidate, { recursive: true });
    const next = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    next.version = target;
    next.covroChannel = stableCandidate ? 'stable' : 'dev';
    next.covroCommit = 'a'.repeat(40);
    if (
      ['codex-mismatch', 'codex-unverified', 'codex-confirmed', 'codex-unsupported'].includes(mode)
    )
      next.covroCodex = {
        recommended: '99.0.0',
        verified: ['99.0.0'],
        unsupported:
          mode === 'codex-unsupported'
            ? [
                {
                  version: CODEX_COMPATIBILITY.recommended,
                  reason: 'Explicit fixture incompatibility',
                },
              ]
            : [],
      };
    if (mode === 'codex-missing') delete next.covroCodex;
    await saveJson(join(candidate, 'package.json'), next);
    if (failure) {
      const journalFile = join(candidate, 'dist/drizzle/meta/_journal.json');
      const journal = JSON.parse(await readFile(journalFile, 'utf8'));
      const last = journal.entries.at(-1);
      journal.entries.push({
        ...last,
        idx: last.idx + 1,
        when: last.when + 1,
        tag: '9999_upgrade_probe',
      });
      next.covroDatabase = { ...next.covroDatabase, schemaVersion: journal.entries.length };
      await saveJson(join(candidate, 'package.json'), next);
      await saveJson(journalFile, journal);
      await writeFile(
        join(candidate, 'dist/drizzle/9999_upgrade_probe.sql'),
        'CREATE TABLE covro_upgrade_probe (id TEXT);',
      );
      const daemonFile = join(candidate, 'dist/cli/daemon.js');
      const daemon = await readFile(daemonFile, 'utf8');
      const marker = 'runtime = await startGateway(config, { updates, maintenance });';
      if (!daemon.includes(marker)) throw new Error('Missing readiness fixture insertion point');
      await writeFile(
        daemonFile,
        daemon.replace(
          marker,
          `${marker}\nthrow new Error('Simulated candidate readiness failure');`,
        ),
      );
    }
    let codexBinary = resolve('tests/fixtures/codex.mjs');
    if (mode === 'codex-restarted') {
      const versionFile = join(directory, 'codex-version');
      await writeFile(versionFile, `codex-cli ${CODEX_COMPATIBILITY.recommended}`);
      const fixture = await readFile(codexBinary, 'utf8');
      codexBinary = join(directory, 'codex-fixture.mjs');
      await writeFile(
        codexBinary,
        fixture
          .replace(
            "'../../package.json'",
            JSON.stringify(pathToFileURL(resolve('package.json')).href),
          )
          .replace(
            'console.log(`codex-cli ${packageJson.covroCodex.recommended}`)',
            `console.log((await import('node:fs')).readFileSync(${JSON.stringify(versionFile)}, 'utf8'))`,
          )
          .replace(
            "fileURLToPath(new URL('./app-server.ts', import.meta.url))",
            JSON.stringify(resolve('tests/fixtures/app-server.ts')),
          ),
      );
      await chmod(codexBinary, 0o700);
      const daemonFile = join(candidate, 'dist/cli/daemon.js');
      const daemon = await readFile(daemonFile, 'utf8');
      const marker = 'runtime = await startGateway(config, { updates, maintenance });';
      if (!daemon.includes(marker)) throw new Error('Missing restart fixture insertion point');
      await writeFile(
        daemonFile,
        daemon.replace(
          marker,
          `await (await import('node:fs/promises')).writeFile(${JSON.stringify(versionFile)}, 'codex-cli 99.0.0');\n${marker}`,
        ),
      );
    }
    const commands = join(directory, 'commands');
    await mkdir(commands);
    const npm = join(commands, 'npm');
    await writeFile(
      npm,
      `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]==='root')console.log(${JSON.stringify(join(directory, 'npm/lib/node_modules'))});else if(args[0]==='install'){if(args.at(-1)!==${JSON.stringify(`${npmPackageName}@${target}`)})throw new Error('Unexpected npm package selector');const prefix=args[args.indexOf('--prefix')+1];fs.mkdirSync(prefix,{recursive:true});fs.cpSync(${JSON.stringify(candidate)},path.join(prefix,'lib/node_modules',${JSON.stringify(npmPackageName)}),{recursive:true});}else process.exit(2);\n`,
    );
    await chmod(npm, 0o700);
    const shellHome = join(directory, 'shell');
    await mkdir(shellHome);
    const env = {
      ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      COVRO_HOME: home,
      HOME: shellHome,
      ZDOTDIR: shellHome,
      CODEX_HOME: join(directory, 'codex-home'),
      NODE_OPTIONS: `--import=${resolve('tests/fixtures/runtime-preload.mjs')}`,
      COVRO_TEST_RELEASE_METADATA: join(candidate, 'package.json'),
    };
    for (const key of ['INVOCATION_ID', 'PM2_HOME', 'SUPERVISOR_ENABLED'])
      delete (env as NodeJS.ProcessEnv)[key];
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Expected port');
    await new Promise<void>((done) => probe.close(() => done()));
    const origin = `http://127.0.0.1:${address.port}`;
    await saveJson(config, {
      port: address.port,
      publicOrigin: [origin],
      dataDir: './data',
      codex: {
        binary: mode === 'codex-unavailable' ? join(directory, 'missing-codex') : codexBinary,
      },
    });
    child = spawn(process.execPath, [join(root, 'bin/covro.mjs'), 'run', '--config', config], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 120; i++) {
      try {
        await control(location, 'status');
        break;
      } catch {
        if (i === 119) throw new Error('Old daemon did not start');
      }
      await setTimeout(100);
    }
    const post = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ path: directory, name: 'Preserved project' }),
    });
    if (!post.ok) throw new Error('Could not register original project');
    const updateDir = join(
      home,
      'updates',
      createHash('sha256')
        .update(root + '/')
        .digest('hex')
        .slice(0, 16),
    );
    // packageRoot from URL includes a trailing slash; preserve the production installation identity.
    const context = {
      location,
      root: root + '/',
      dataDir: join(directory, 'data'),
      directory: updateDir,
    };
    await mkdir(updateDir, { recursive: true });
    await saveJson(join(updateDir, 'context.json'), context);
    const id = randomUUID();
    await saveJson(join(updateDir, 'run.json'), {
      id,
      from: metadata.version,
      target,
      channel: subscription,
      sourceChannel: stableCandidate ? 'stable' : 'dev',
      commit: mode === 'commit-mismatch' ? 'b'.repeat(40) : next.covroCommit,
      codex: {
        version: mode === 'codex-changed' ? '0.162.1' : CODEX_COMPATIBILITY.recommended,
        manifest:
          mode === 'codex-mismatch' || mode === 'codex-missing'
            ? CODEX_COMPATIBILITY
            : next.covroCodex,
        confirmedUnverified: ['codex-confirmed', 'codex-unsupported'].includes(mode),
      },
      phase: mode === 'repair' ? 'verifying' : repair ? 'failed' : 'installing',
      message: 'Fixture npm transport',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (mode === 'repair') {
      // Model a process crash after candidate migrations, before activation was committed.
      const admission = await control<{ ready: boolean }>(location, 'prepare-update');
      if (!admission.ready) throw new Error('Original service did not close admission');
      await stopAndWait(location);
      const snapshot = transactionPaths(
        root,
        id,
        context.dataDir,
        config,
        join(updateDir, `backup-${id}`),
      );
      await mkdir(snapshot.backup, { recursive: true });
      await cp(join(context.dataDir, 'app.sqlite'), join(snapshot.backup, 'app.sqlite'));
      await cp(config, join(snapshot.backup, 'config.json'));
      await saveJson(join(snapshot.backup, 'snapshot.json'), { complete: true });
      await rename(root, snapshot.previous);
      await cp(candidate, root, { recursive: true });
      const interrupted = new Database(join(context.dataDir, 'app.sqlite'));
      interrupted.exec('CREATE TABLE covro_upgrade_probe (id TEXT)');
      interrupted.close();
    }
    if (mode === 'repair-resumed') {
      // A previous recovery resumed writes but left an old package backup behind.
      const snapshot = transactionPaths(
        root,
        id,
        context.dataDir,
        config,
        join(updateDir, `backup-${id}`),
      );
      await cp(root, snapshot.previous, { recursive: true });
      const saved = await fetch(`${origin}/api/projects`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ path: commands, name: 'Must retain resumed data' }),
      });
      if (!saved.ok) throw new Error('Could not write resumed-service data');
    }
    worker = spawn(
      process.execPath,
      [resolve('dist/update-worker.cjs'), updateDir, ...(repair ? ['--repair'] : [])],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let errors = '';
    worker.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const exit = await Promise.race([
      once(worker, 'exit'),
      setTimeout(100_000, undefined, { ref: false }).then(() => {
        throw new Error('Upgrade worker timed out');
      }),
    ]);
    const record = JSON.parse(await readFile(join(updateDir, 'run.json'), 'utf8')) as UpdateRun;
    if (
      exit[0] !== (mode === 'repair-resumed' || rejected ? 1 : 0) ||
      record.phase !==
        (mode === 'repair-resumed' || rejected ? 'failed' : rolledBack ? 'rolledBack' : 'succeeded')
    )
      throw new Error(`Unexpected upgrade outcome: ${JSON.stringify(record)} ${errors}`);
    const current = await control<{ version: string; maintenance: boolean }>(location, 'status');
    if (
      current.version !== (rolledBack || rejected ? metadata.version : target) ||
      current.maintenance
    )
      throw new Error('Service activation did not settle');
    if (stableCandidate) {
      const status = (await (await fetch(`${origin}/api/updates`)).json()) as {
        settings: { channel: string };
        run: UpdateRun;
      };
      if (status.settings.channel !== subscription || status.run.sourceChannel !== 'stable')
        throw new Error(
          'Stable activation changed the subscribed channel or lost the candidate source',
        );
    }
    if (rejected) {
      const snapshot = transactionPaths(
        root,
        id,
        context.dataDir,
        config,
        join(backupDirectory(home, context.dataDir), id),
      );
      if (
        await readFile(join(snapshot.backup, 'snapshot.json'), 'utf8').then(
          () => true,
          () => false,
        )
      )
        throw new Error('Rejected Codex update stopped service and took a snapshot');
      const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (installed.version !== metadata.version)
        throw new Error('Rejected Codex update replaced the installation');
    }
    const projects = (await (await fetch(`${origin}/api/projects`)).json()) as {
      data: { name: string }[];
    };
    if (!projects.data.some((project) => project.name === 'Preserved project'))
      throw new Error('Project data was lost');
    if (
      mode === 'repair-resumed' &&
      !projects.data.some((project) => project.name === 'Must retain resumed data')
    )
      throw new Error('Resumed-service data was overwritten');
    const db = new Database(join(directory, 'data/app.sqlite'), { readonly: true });
    try {
      if (
        failure &&
        db.prepare("SELECT name FROM sqlite_master WHERE name='covro_upgrade_probe'").get()
      )
        throw new Error('Failed candidate migration was not rolled back');
    } finally {
      db.close();
    }
    console.log(
      `PASS: real worker ${mode === 'codex-restarted' ? 'rolled back after the configured Codex changed at restart' : rejected ? `rejected ${mode} before stopping or replacing the service` : mode === 'codex-confirmed' ? 'activated the explicitly confirmed unverified Codex combination' : mode === 'repair-resumed' ? 'refused snapshot restore after the original service resumed writes' : repair ? 'repaired an interrupted activation and verified the restored service' : failure ? 'restored package, database and project after failed migration/readiness' : 'activated exact candidate and reopened task admission'} (fixture npm transport)`,
    );
  } finally {
    await stopBackground(location).catch(() => {});
    for (const process of [worker, child])
      if (process && process.exitCode === null) {
        process.kill('SIGTERM');
        await once(process, 'exit');
      }
    await rm(directory, { recursive: true, force: true });
  }
}

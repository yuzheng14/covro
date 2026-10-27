import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { stopAndWait } from './control.js';
import { saveJson } from '../updates/files.js';
import { ensureConfig, packageRoot, type CovroPaths } from './paths.js';
import { macOSLoginService } from './background.js';
import { launchRuntime, systemdQuote as unit } from './runtime-launch.js';

const exec = promisify(execFile);

export async function service(location: CovroPaths, install: boolean) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      '登录自启目前支持 macOS launchd 和 Linux systemd --user；可使用 covro start 后台运行。',
    );
  const label = `dev.covro.${location.key}`;
  const entry = join(packageRoot, 'bin/covro.mjs');
  if (process.platform === 'darwin') {
    if (install) await ensureConfig(location);
    await macOSLoginService(location, entry, install);
    return;
  }
  if (install) {
    await stopAndWait(location);
    await mkdir(location.state, { recursive: true, mode: 0o700 });
  }
  const directory = join(homedir(), '.config/systemd/user');
  const filename = join(directory, `${label}.service`);
  if (install) {
    await mkdir(directory, { recursive: true });
    const runtime = await launchRuntime(location, entry);
    if (
      /[\r\n]/.test(
        [runtime.node, runtime.entry, location.config, location.home, runtime.path].join(''),
      )
    )
      throw new Error('服务路径和 PATH 不能包含换行');
    await writeFile(
      filename,
      `[Unit]\nDescription=Covro\n[Service]\nExecStart=${[runtime.node, runtime.entry, 'run', '--config', location.config].map(unit).join(' ')}\nEnvironment=${unit(`COVRO_HOME=${location.home}`)} ${unit(`PATH=${runtime.path}`)}\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', '--now', `${label}.service`]);
    await saveJson(join(location.state, 'service.json'), { platform: 'linux', label });
  } else {
    await exec('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
    await rm(filename);
    await rm(join(location.state, 'service.json'), { force: true });
    await exec('systemctl', ['--user', 'daemon-reload']);
  }
}

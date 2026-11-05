import { nullLogger, type Logger } from '../logging/logger.js';
import { logContext } from '../logging/context.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import type {
  CloneProjectInput,
  CreateProjectInput,
  Project,
  ProjectClone,
} from '../shared/types.js';
import { cloneProjectSchema } from '../shared/validation.js';
import { containsPath } from './projects.js';

interface Job {
  view: ProjectClone;
  fingerprint: string;
  child?: ChildProcess;
  done: Promise<void>;
}
const active = (job: Job) => ['cloning', 'cancelling'].includes(job.view.status);
const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Only remote Git transports; never pass a local path, option, or remote helper to Git. */
export function validateRepository(repository: string): void {
  let valid = false;
  if (!hasControl(repository) && !/[\s\\]/.test(repository)) {
    if (/^(https|ssh):\/\//.test(repository)) {
      try {
        const url = new URL(repository);
        valid = Boolean(
          url.hostname &&
          !url.hostname.startsWith('-') &&
          url.pathname.length > 1 &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === 'ssh:'
            ? /^(?:[a-zA-Z0-9_][\w.-]*)?$/.test(url.username)
            : !url.username),
        );
      } catch {
        /* Report a fixed message, never the supplied URL. */
      }
    } else {
      valid = /^(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][\w.-]*:[^/:\s][^\s]*$/.test(repository);
    }
  }
  if (!valid)
    throw new AppError(
      'INVALID_REPOSITORY',
      '请输入 HTTPS 或 SSH Git 仓库地址；请使用主机已有的认证，不要在地址中填写密码、令牌或查询参数',
      400,
    );
}

function targetPath(path: string): string {
  if (!isAbsolute(path) || hasControl(path) || resolve(path) === dirname(resolve(path)))
    throw new AppError('INVALID_PROJECT_PATH', '请填写服务器上的绝对目标目录', 400);
  try {
    const target = join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
    accessSync(dirname(target), constants.W_OK | constants.X_OK);
    return target;
  } catch {
    throw new AppError(
      'CLONE_PARENT_UNAVAILABLE',
      '目标目录的父目录必须已存在，且服务需要写入和进入权限',
      409,
    );
  }
}

function checkEmpty(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length)
      throw new AppError(
        'CLONE_TARGET_EXISTS',
        '目标目录已存在且非空，或不是普通目录；请选择新的空目录，不会覆盖已有文件',
        409,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof AppError) throw error;
    throw new AppError(
      'CLONE_TARGET_UNAVAILABLE',
      '无法检查目标目录，请检查服务器路径和访问权限',
      409,
    );
  }
}

function failure(
  output: string,
  missingGit: boolean,
): { code: NonNullable<ProjectClone['errorCode']>; message: string } {
  if (missingGit)
    return {
      code: 'CLONE_GIT_MISSING',
      message: '服务器未安装 Git，或服务的 PATH 中找不到 Git。安装并配置后重试。',
    };
  if (
    /authentication failed|could not read username|permission denied|publickey|terminal prompts disabled|credential|access denied|401|403/i.test(
      output,
    )
  )
    return {
      code: 'CLONE_AUTH_FAILED',
      message:
        'Git 认证失败或没有仓库访问权限。请在运行服务的主机上配置 Git 凭据或 SSH 密钥后重试。',
    };
  if (/host key verification failed/i.test(output))
    return {
      code: 'CLONE_HOST_KEY_FAILED',
      message: 'SSH 主机验证失败。请在运行服务的主机上确认并配置仓库主机的 SSH 信任后重试。',
    };
  if (
    /repository .*not found|does not appear to be a git repository|not a repository|404/i.test(
      output,
    )
  )
    return {
      code: 'CLONE_REPOSITORY_UNAVAILABLE',
      message: '仓库不存在或不可访问。请检查仓库地址和主机上的 Git 访问权限。',
    };
  if (
    /could not resolve|failed to connect|unable to access|connection|timed out|certificate/i.test(
      output,
    )
  )
    return {
      code: 'CLONE_NETWORK_FAILED',
      message: '无法连接 Git 仓库。请检查服务器网络、代理和证书配置后重试。',
    };
  if (/already exists and is not an empty directory/i.test(output))
    return {
      code: 'CLONE_TARGET_NOT_EMPTY',
      message: '目标目录已包含文件，Git 已停止克隆；不会覆盖或删除已有文件。',
    };
  if (/no space left|disk quota/i.test(output))
    return {
      code: 'CLONE_DISK_FULL',
      message: '服务器磁盘空间不足，请释放空间后使用新的空目录重试。',
    };
  return {
    code: 'CLONE_FAILED',
    message: 'Git 克隆失败。请检查仓库地址、主机上的 Git 认证、目录权限和磁盘空间后重试。',
  };
}

/** Transient jobs never persist repository URLs, credentials, or raw Git output. */
export class ProjectClones {
  private readonly jobs = new Map<string, Job>();
  private closing = false;
  constructor(
    private readonly register: (input: CreateProjectInput) => Project,
    private readonly registered: (path: string) => boolean,
    private readonly logger: Logger = nullLogger,
  ) {}

  get hasActive(): boolean {
    return [...this.jobs.values()].some(active);
  }

  assertIdlePath(path: string): void {
    if (!this.hasActive) return;
    let canonical = resolve(path);
    try {
      canonical = realpathSync(path);
    } catch {
      try {
        canonical = join(realpathSync(dirname(canonical)), basename(canonical));
      } catch {
        /* Normal registration validation reports unavailable paths. */
      }
    }
    if (
      [...this.jobs.values()].some(
        (job) =>
          active(job) &&
          (containsPath(job.view.path, canonical) || containsPath(canonical, job.view.path)),
      )
    )
      throw new AppError('CLONE_IN_PROGRESS', '该目录正在克隆，请等待完成或取消后再操作', 409);
  }

  start(input: CloneProjectInput, resolvePath = (path: string) => path): ProjectClone {
    const parsed = cloneProjectSchema.parse(input);
    validateRepository(parsed.repository);
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const previous = this.jobs.get(parsed.clientOperationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError('CLONE_ID_CONFLICT', '该操作 ID 已用于其他克隆请求', 409);
      return this.get(previous.view.id);
    }
    if (this.closing) throw new AppError('GATEWAY_STOPPING', '服务正在停止，请稍后重试', 503);
    const path = targetPath(resolvePath(parsed.path));
    this.assertIdlePath(path);
    if (this.registered(path))
      throw new AppError('PROJECT_EXISTS', '该目录已添加为项目，请使用已有项目或选择其他目录', 409);
    checkEmpty(path);
    if ([...this.jobs.values()].filter(active).length >= 4)
      throw new AppError('CLONE_LIMIT', '已有多个仓库正在克隆，请等待完成后重试', 409);
    // Bound transient history without evicting a running process.
    if (this.jobs.size >= 100) {
      const oldest = [...this.jobs].find(([, job]) => !active(job));
      if (oldest) this.jobs.delete(oldest[0]);
    }
    const job: Job = {
      view: {
        id: parsed.clientOperationId,
        path,
        name: parsed.name,
        status: 'cloning',
        progress: '正在连接仓库…',
        progressStage: 'connecting',
      },
      fingerprint,
      done: Promise.resolve(),
    };
    this.jobs.set(job.view.id, job);
    job.done = this.run(job, parsed.repository);
    return this.get(job.view.id);
  }

  get(id: string): ProjectClone {
    const job = this.jobs.get(id);
    if (!job)
      throw new AppError(
        'CLONE_NOT_FOUND',
        '未找到克隆记录；服务重启后请检查目标目录，再添加已有目录或使用新的空目录重试',
        404,
      );
    return structuredClone(job.view);
  }

  cancel(id: string): ProjectClone {
    const job = this.jobs.get(id);
    this.get(id);
    if (job && active(job) && job.view.status !== 'cancelling') {
      job.view.status = 'cancelling';
      job.view.progress = '正在取消，等待 Git 退出…';
      job.view.progressStage = 'cancelling';
      this.signal(job, 'SIGTERM');
    }
    return this.get(id);
  }

  retryRegistration(id: string): ProjectClone {
    const job = this.jobs.get(id);
    this.get(id);
    if (job?.view.status === 'registration-failed') this.finishRegistration(job);
    return this.get(id);
  }

  private finishRegistration(job: Job): void {
    try {
      job.view.project = this.register({ path: job.view.path, name: job.view.name });
      job.view.status = 'completed';
      job.view.progress = '克隆完成，项目已添加';
      job.view.progressStage = 'completed';
      delete job.view.errorCode;
      delete job.view.error;
    } catch {
      job.view.status = 'registration-failed';
      job.view.progress = '克隆已完成，项目尚未添加';
      job.view.progressStage = 'registration_failed';
      job.view.errorCode = 'CLONE_REGISTRATION_FAILED';
      job.view.error =
        '项目注册失败。已克隆的文件保留在目标目录；可重试添加项目，无需再次克隆，也可通过“已有目录”添加。';
    }
  }

  private signal(job: Job, signal: NodeJS.Signals): void {
    if (!job.child?.pid) return;
    try {
      if (process.platform === 'win32') job.child.kill(signal);
      else process.kill(-job.child.pid, signal);
    } catch {
      /* Process may have already exited. */
    }
  }

  private async run(job: Job, repository: string): Promise<void> {
    const logger = this.logger.child({
      ...logContext(),
      cloneId: job.view.id,
      operationId: job.view.id,
    });
    const started = performance.now();
    logger.info('clone.started');
    let output = '';
    let pending = '';
    let missingGit = false;
    let timedOut = false;
    const sshCommand =
      process.env.GIT_SSH_COMMAND ??
      (process.env.GIT_SSH ? `'${process.env.GIT_SSH.replaceAll("'", "'\\''")}'` : 'ssh');
    const child = spawn(
      'git',
      [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        'clone',
        '--progress',
        '--',
        repository,
        job.view.path,
      ],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_SSH_COMMAND: `${sshCommand} -oBatchMode=yes -oStrictHostKeyChecking=yes`,
          LC_ALL: 'C',
        },
      },
    );
    job.child = child;
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      pending = (pending + chunk.toString()).slice(-4096);
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match =
          /^(?:remote: )?(Receiving objects|Resolving deltas|Updating files|Checking out files|Counting objects|Compressing objects):\s+(\d{1,3})%/.exec(
            line,
          );
        if (!match || job.view.status !== 'cloning') continue;
        const labels: Record<string, [NonNullable<ProjectClone['progressStage']>, string]> = {
          'Receiving objects': ['receiving', '正在接收对象'],
          'Resolving deltas': ['resolving', '正在解析差异'],
          'Updating files': ['checking_out', '正在检出文件'],
          'Checking out files': ['checking_out', '正在检出文件'],
          'Counting objects': ['counting', '正在统计对象'],
          'Compressing objects': ['compressing', '正在压缩对象'],
        };
        [job.view.progressStage, job.view.progress] = labels[match[1]!]!;
        job.view.percent = Math.min(100, Number(match[2]));
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    const timeout = setTimeout(() => {
      timedOut = true;
      this.cancel(job.view.id);
    }, 30 * 60_000);
    timeout.unref();
    const escalation = setInterval(() => {
      if (job.view.status === 'cancelling') this.signal(job, 'SIGKILL');
    }, 3000);
    escalation.unref();
    const code = await new Promise<number | null>((done) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        missingGit = error.code === 'ENOENT';
      });
      child.once('close', done);
    });
    clearTimeout(timeout);
    clearInterval(escalation);
    job.child = undefined;
    delete job.view.percent;
    if (job.view.status === 'cancelling') {
      job.view.status = timedOut ? 'failed' : 'cancelled';
      job.view.progress = timedOut ? '克隆超时，已停止' : '已取消克隆';
      job.view.progressStage = timedOut ? 'timed_out' : 'cancelled';
      job.view.errorCode = timedOut ? 'CLONE_TIMED_OUT' : 'CLONE_CANCELLED';
      job.view.error = `${timedOut ? '克隆超过 30 分钟，已停止。' : ''}未添加项目，也未删除任何文件。目标目录可能残留文件，请检查后使用新的空目录重试。`;
    } else if (code !== 0) {
      job.view.status = 'failed';
      job.view.progress = '克隆失败';
      job.view.progressStage = 'failed';
      const problem = failure(output, missingGit);
      job.view.errorCode = problem.code;
      job.view.error = `${problem.message} 未添加项目；目标目录可能残留文件，请检查后使用新的空目录重试。`;
    } else this.finishRegistration(job);
    logger[job.view.status === 'failed' ? 'warn' : 'info']('clone.finished', {
      outcome: job.view.status,
      stage: job.view.progressStage,
      errorCode: job.view.errorCode,
      exitCode: code,
      durationMs: Math.round(performance.now() - started),
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.jobs.values()) if (active(job)) this.cancel(job.view.id);
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
}

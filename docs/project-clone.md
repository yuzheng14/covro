# Clone a project / 克隆项目

In **添加项目** (Add project), choose **克隆 Git 仓库** (Clone Git repository). Enter an HTTPS or SSH Git address, a destination directory on the computer running Covro, and an optional project name. The destination's parent must already exist and be writable. The destination must be absent or an empty ordinary directory; nonempty directories, files and destination symlinks are refused. Existing project imports remain available under **已有目录** (Existing directory).

在「添加项目」中选择「克隆 Git 仓库」，填写 HTTPS 或 SSH 仓库地址、运行 Covro 的主机上的目标目录和可选名称。父目录须已存在且可写；目标须不存在或为空的普通目录，不接受非空目录、文件或目标符号链接。已有本地项目仍通过「已有目录」添加。

## Base directory (workDir) / 项目基础目录

In **Service configuration → Data and projects**, set **Project base directory (workDir, optional)** to an existing, readable directory on the service host. It must be an absolute path; Covro does not create it. The setting is optional in the startup JSON as well:

```json
{ "workDir": "/workspace/projects" }
```

- Existing directory imports initially show `workDir`. A relative entry such as `demo` resolves to `/workspace/projects/demo`.
- Cloning `https://host/org/demo.git`, `git@host:org/demo.git`, or `ssh://git@host/org/demo.git` suggests `/workspace/projects/demo`. Changing the repository updates the suggestion until you edit the destination yourself.
- Both forms show the final host-resolved path before submission. Absolute entries such as `/other/demo` override `workDir`. Relative paths follow the host's normal path rules, including `..`; this setting is a default, not a directory access restriction.
- Saving through Service configuration persists the value and immediately applies it to future operations; refreshes and service restarts retain it. Clearing the field restores the previous requirement for absolute paths. Direct JSON edits take effect after a restart. Other service settings still require a restart.
- Existing projects, in-progress clones and their retries retain their original paths. No project files are moved. The directory must be accessible when used; invalid or unavailable settings show an error. An explicit absolute path can still be used if `workDir` becomes unavailable. Cloning additionally requires write permission on the destination's existing parent.

在 **服务配置 → 数据与项目** 中设置 **项目基础目录（workDir，可选）**，填写服务主机上已存在且可读取、进入的绝对目录；Covro 不会创建该目录。也可以在启动 JSON 中添加可选的 `workDir` 字段，如上例。

- 添加已有目录时初始显示 `workDir`。输入相对路径 `demo`，最终路径为 `/workspace/projects/demo`。
- 克隆 HTTPS、SCP 风格 SSH 或 SSH URL 的 `demo.git` 仓库时，默认建议 `/workspace/projects/demo`。手动编辑目标目录后，继续修改仓库地址不会覆盖所填目录。
- 两种表单提交前均显示服务器解析后的最终路径。绝对路径 `/other/demo` 直接使用，不再拼接。相对路径按主机规则处理，包括 `..`；此配置是默认前缀，不限制项目目录范围。
- 通过服务配置保存后立即用于后续操作，刷新或重启后仍保留。清空该字段即恢复原有的绝对路径填写方式。直接编辑 JSON 后需要重启；其他服务配置仍需重启。
- 已有项目、进行中的克隆及其重试保留原路径，不会移动项目文件。目录使用时必须可访问，无效或不可用时会提示；此时仍可填写其他绝对路径继续。克隆还要求目标的父目录已存在且可写。

## Git and authentication / Git 与认证

- Git must be installed and available in the **service's PATH**, which can differ from your terminal's PATH. Covro invokes Git directly on the host, independently of the Codex agent sandbox.
- HTTPS, `git@host:owner/repository.git`, and `ssh://git@host:port/owner/repository.git` are supported. HTTP, local/file URLs, Git remote helpers, URL passwords/tokens and query parameters are rejected.
- Configure the service user's existing Git credential helper or SSH keys first. Cloning does not prompt for passwords or accept new SSH host keys; configure host trust on the host beforehand. It inherits Git configuration and credential helpers; it does not use or copy Codex model-provider credentials.
- The UI exposes only recognized progress stages and fixed error messages. Raw Git output and repository URLs are not saved in Covro's project configuration or job history. Git itself records the remote in the checkout's `.git/config` as usual.

- 主机须安装 Git，且**服务的 PATH** 能找到它；后台服务与终端的 PATH 可能不同。克隆直接在主机运行，与 Codex Agent 的沙箱独立。
- 支持 HTTPS、`git@host:owner/repository.git` 和 `ssh://git@host:port/owner/repository.git`；不接受 HTTP、本地/file 地址、Git remote helper、URL 密码/令牌和查询参数。
- 请先为运行服务的用户配置 Git 凭据助手或 SSH 密钥。克隆不进行密码交互，也不会接受新的 SSH 主机密钥；请提前在主机配置 SSH 信任。沿用已有 Git 配置和凭据助手，不读取或复制 Codex 模型服务凭据。
- 页面只显示识别出的进度阶段和固定错误提示，不在 Covro 项目配置或任务记录中保存原始 Git 输出和仓库地址。Git 仍按其通常行为在检出目录的 `.git/config` 中记录远程地址。

## Background tasks, cancellation and recovery / 后台任务、取消与恢复

- Choose **Run in background** (后台运行), close the dialog, or press Escape to return to chat. These actions only hide details. **Cancel clone** (取消克隆) explicitly stops Git; cancellation remains pending until Git exits. You can keep chatting or switch conversations during cloning.
- **Tasks** in the top toolbar lists running tasks first and the most recent results (up to 100 retained snapshots). Select a task to reopen its stage, available percentage, destination, errors and actions. Refresh, reconnect, another tab or another device using the same service reads this server history; no browser storage is required and recovery never starts a clone. A disconnected view explicitly reports that its displayed state needs checking.
- Completion adds the project using the existing registration flow and shows a temporary, non-modal **View** prompt. The current project, session and draft stay selected. Choose **Open project** in task details when ready to navigate. Failed tasks retain fixed diagnostic codes and recovery instructions; **Retry adding project** reuses a completed checkout after registration failure without another clone.
- Progress percentages belong to the current Git stage, not the entire clone. At most **four** clones run at once, each for at most **30 minutes**. Active destinations, aliases and overlapping directories are locked against concurrent imports/clones. Different tasks have independent cancellation and outcomes.
- Task snapshots and hashed request identities are stored in the instance SQLite database (DB Schema 11), without repository URLs, credentials or raw Git output. Old snapshots expire as new tasks arrive; their hashed identities remain so replaying an expired operation ID cannot start another clone. The API returns a missing-record error for an expired snapshot; retry requires an explicit new operation and an absent/empty destination.
- Both automatic and manual upgrades, and backups, wait for running or cancelling clones. The final idle gate also prevents new clones and registration retries during maintenance. This work does not change upgrade scheduling.
- Stopping the service interrupts active clones. A child-process guardian requests Git termination on server IPC loss, including abrupt server termination, with forceful termination after three seconds on supported process groups. On restart, unfinished persisted records become **Service interrupted; clone result unconfirmed**. They are never treated as running, automatically restarted, registered as successful or resumed from Git progress. A narrow crash between successful checkout/registration and saving the final snapshot can leave an unconfirmed result: inspect the destination and existing project list first. This is task-status recovery, not resumable Git transfer. A user cancellation already in progress completes as cancelled on an orderly stop; after an abrupt restart an unfinished cancellation is also unconfirmed.
- Covro never deletes destination files after failure, cancellation or interruption. Inspect the displayed directory on the host. Add it through **Existing directory** only after verifying a complete checkout; otherwise retry in another absent/empty directory. Registered projects and completed task results survive restarts. When first upgrading from versions with in-memory clone records, those older records cannot be recovered; inspect their destinations before retrying.

- 选择「后台运行」、关闭详情或按 Escape，即可返回聊天；这些操作只收起详情。「取消克隆」才会停止 Git，且等待 Git 退出后才显示取消完成。克隆时可以继续聊天或切换会话。
- 顶部「任务」优先显示运行中任务与近期结果（最多保留 100 份任务快照）。选择任务可重开阶段、可用百分比、目标目录、错误与操作。刷新、重连、另一标签页或同服务的另一设备均读取服务端记录，不依赖浏览器存储，也不因恢复而重新克隆。断线时明确提示所示状态需要重新核对。
- 完成后沿用现有注册流程添加项目，并显示短暂、不阻塞操作的「查看」提示。当前项目、会话和草稿保持不变；准备切换时在详情中点击「打开项目」。失败记录保留固定诊断代码与恢复说明；注册失败时「重试添加项目」复用已完成的检出，不重复克隆。
- 百分比只代表当前 Git 阶段，不代表整体。最多同时克隆 **4** 个仓库，每次最多 **30 分钟**。同一目标、路径别名和重叠的活动目录禁止并发导入/克隆；各任务取消与结果相互独立。
- 快照与请求哈希持久保存在实例 SQLite（DB Schema 11），不保存仓库 URL、凭据和原始 Git 输出。新任务到来时淘汰旧快照，但保留请求哈希，重复提交已过期操作 ID 不会重新克隆；API 会返回记录不存在，重试需要用户主动发起新操作并使用不存在或为空的目录。
- 自动/手动升级及备份都会等待运行中或取消中的克隆；最终空闲门禁也会禁止维护期间发起克隆或重试注册。本次不改变升级调度。
- 停止服务会中断活动克隆。子进程守护在服务 IPC 断开（包括异常退出）时请求停止 Git，并在支持的进程组上于 3 秒后强制终止。重启后，未结束记录转为「服务中断，克隆结果未确认」，不会一直显示运行中、自动重试、按成功注册或按原进度续传。在检出/注册成功与最终快照落盘之间发生崩溃时，结果仍可能未确认，须先检查目录和已有项目列表；恢复的是任务状态，不是 Git 传输。用户已在取消的任务于正常停止时会完成取消；异常重启时未结束的取消也归为结果未确认。
- 失败、取消或中断后，Covro 均不删除目标目录文件。请在主机检查；仅在确认完整检出后通过「已有目录」添加，否则换一个不存在或为空的目录重试。已注册项目与完成记录跨重启保留。首次从仅内存记录的旧版升级时，旧版任务记录无法恢复，重试前须检查目标目录。

## Verification / 验证

Integration and browser tests use a test-only transport wrapper to clone a real local Git repository through accepted HTTPS/SSH address forms. They cover directory conflicts, aliases, duplicate requests, background chat and session switching, independent browser clients, refresh/reconnect/cancellation, completion without navigation, missing Git, authentication errors, registration retry and upgrade/backup idle admission. An isolated gateway process is forcibly terminated and restarted after its instance lock expires to verify interruption, Git termination and persistent request deduplication. They do not authenticate to a live private remote or validate a user's credential helper.

集成与浏览器测试通过仅测试使用的传输包装器，将合法 HTTPS/SSH 地址映射到真实本地 Git 仓库执行克隆，覆盖目录冲突、别名、重复请求、后台聊天与会话切换、独立浏览器客户端、刷新/重连/取消、完成不跳转、缺少 Git、认证错误、注册重试及升级/备份空闲门禁；另通过强制终止并等待实例锁过期后重启的隔离服务，验证中断、Git 退出与跨重启去重；不连接真实私有仓库认证，也不验证用户的凭据助手。

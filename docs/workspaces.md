# Conversation workspaces / 会话工作目录

## Start without a project

Click **＋** beside the **未关联项目** (Unassigned) heading to start without choosing or registering a project. This group remains visible even before its first conversation. Project heading buttons still start conversations in that project. With no registered projects, the welcome page accepts a prompt directly.

The first send allocates `<dataDir>/workspaces/<creation-operation-UUID>/` on the computer running Covro. Opening a blank draft does not allocate a session directory. The shared `workspaces` parent may be created while reading default settings. `dataDir` follows the existing server configuration; there is no new required setting. Conversation titles are independent of directory names. The conversation header exposes its working directory.

Unassigned conversations appear under **未关联项目** and support the existing settings, history, rename, archive, restore, and notification flows. Codex receives that session's directory as `cwd`; it does not receive another conversation's directory or the service launch directory. Files can be created directly there; there is no required `work`/`outputs` layout.

Covro stores the allocation and thread association in SQLite; Codex remains responsible for conversation history and archive state. Refresh, reconnect, service restart, and later dates reuse the saved directory. A missing/replaced directory produces an error instead of creating an empty replacement. Fork copies the current workspace files into a separate directory; changes during the copy are not a transactional filesystem snapshot. Project forks retain their existing behavior.

Creation and first-turn submission retain the existing durable operation IDs. Failures preserve the browser draft; retries of a known operation do not replay it. An uncertain creation can be identified by its dedicated directory when the native thread index is readable. The browser confirms the receipt before proceeding; it does not silently resend a prompt. A failed first turn reuses the already-created thread.

There is no automatic expiration or cleanup. Closing the page, renaming, and archiving never delete files. Failed or unconfirmed allocations are retained for inspection. Back up the entire `dataDir`, including `app.sqlite` and `workspaces`, together with the configured Codex home. Deleting `dataDir` now also deletes these session files. Manual directory removal makes affected conversations unavailable; archive is the normal way to hide completed work.

File previews authorize the conversation's own workspace. Other allocated session directories are excluded even if they are beneath a project or a temporary root; symlink targets are checked as well. Existing project previews retain their project and temporary-root policy. These checks do not replace the permission and sandbox policy actually enforced by Codex.

## Open the GitHub repository

The GitHub icon in the header opens the current workspace's repository in a new tab on desktop and mobile. With a conversation selected, Covro uses that conversation's actual working directory; a project draft uses the project's directory. Repository subdirectories and Git worktrees are supported. The link refreshes when switching projects or conversations and when returning focus to the page.

Covro reads Git configuration locally without contacting GitHub. HTTPS, SSH (`git@github.com:owner/repo.git` and `ssh://git@github.com/owner/repo.git`), HTTP, and Git protocol URLs on `github.com` become `https://github.com/owner/repo` links with credentials, query strings, fragments, and the `.git` suffix removed. SSH aliases and other hosting domains are not inferred.

Remote selection is conservative: if `origin` exists, only its fetch URL(s) are considered; otherwise all remotes must resolve to the same GitHub repository. Multiple URLs are accepted only when they identify the same repository. If the preferred remote is unrecognized or candidates disagree, the icon is hidden. Non-Git directories, unavailable Git/configuration, and workspaces without a GitHub remote also hide the icon.

## 不选择项目直接开始

点击侧栏 **未关联项目** 标题右侧的 **＋**，无需选择或注册项目即可发送任务；还没有这类会话时也会显示该分组。项目标题旁的按钮仍在该项目内创建会话。没有注册任何项目时，欢迎页也可以直接输入和发送。

首次发送会在运行 Covro 的电脑上分配 `<dataDir>/workspaces/<创建操作 UUID>/`。打开空白草稿不会分配会话目录；读取默认设置时可能创建共享的 `workspaces` 父目录。根目录沿用现有服务端 `dataDir` 配置，无需新增配置项。会话改名不改变目录，标题下的“工作目录”可查看实际路径。

这类会话列在 **未关联项目** 下，沿用现有设置、历史、重命名、归档、恢复和通知功能。Codex 的 `cwd` 是当前会话的独立目录，文件直接保存在其中，不强制拆分 `work`、`outputs`。

SQLite 保存分配记录与会话关联，Codex 继续保存会话历史和归档状态。刷新、重连、服务重启及跨日期恢复都使用原目录；目录丢失或真实路径变化时明确报错，不自动创建空目录代替。Fork 会把当前工作目录的文件复制到独立目录，复制过程中发生的写入不保证形成一致快照；普通项目的 Fork 行为保持不变。

创建和首轮发送沿用持久操作 ID。失败时保留浏览器草稿，重复请求不会重新执行；创建结果未知时，可通过独立目录和可读取的原生会话索引核对结果。浏览器先确认回执，不静默重发 Prompt。首轮发送失败后复用已创建的会话。

**没有自动过期或自动清理。** 关闭页面、改名和归档都不删除文件；失败或待核对的目录也保留供检查。备份时应一起保存整个 `dataDir`（包含 SQLite 和 `workspaces`）以及所配置的 Codex home。删除 `dataDir` 也会删除这些会话文件；手工删除工作目录会使对应会话不可用，日常隐藏已完成工作请使用归档。

无项目会话的文件预览仅允许自己的工作目录。其他会话目录即使位于项目目录或系统临时目录下，也不能通过预览跨会话访问，软链接目标同样会被校验。项目会话沿用原来的项目及临时目录策略。这些校验不代替 Codex 实际执行的权限和沙箱策略。

## 快捷打开 GitHub 仓库

桌面和手机均可点击顶部 GitHub 图标，在新标签页打开当前工作区的仓库。选中会话时使用会话的实际工作目录，项目草稿则使用项目目录；支持仓库子目录和 Git worktree。切换项目、会话及重新聚焦页面时会更新链接。

识别只读取本地 Git 配置，不请求 GitHub。支持 `github.com` 的 HTTPS、SSH（`git@github.com:owner/repo.git`、`ssh://git@github.com/owner/repo.git`）、HTTP 和 Git 协议地址，统一转换为 `https://github.com/owner/repo`，移除凭据、查询参数、片段和 `.git` 后缀；不推测 SSH 别名或其他托管域名。

优先使用 `origin` 的 fetch URL；没有 `origin` 时，所有 remote 必须指向同一 GitHub 仓库。一个 remote 有多个 URL 时，也须全部指向同一仓库。首选 remote 无法识别或候选仓库不一致时隐藏入口。非 Git 目录、Git 或配置不可用、没有 GitHub remote 时也不显示图标。

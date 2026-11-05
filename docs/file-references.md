# Workspace file references / 工作区文件引用

Type `@` at the start of the input, after whitespace, or after an opening bracket, then type part of a file path. For queries containing spaces, start with `@"`, for example `@"docs/中文 说`. Candidates show full relative paths so same-name files remain distinguishable. Use Up/Down and Enter/Tab to select, or tap a candidate. Escape closes the menu and keeps literal text; email addresses, escaped `\@`, inline code, and unselected `@` text remain ordinary text. Mobile Enter inserts a newline; use the send button.

在输入开头、空白或左括号后输入 `@`，继续输入部分文件路径。查询含空格时以 `@"` 开始，例如 `@"docs/中文 说`。候选展示完整相对路径，同名文件可区分。方向键切换，Enter/Tab 选择，触屏直接点击；Escape 关闭候选且保留原文。邮箱、转义的 `\@`、行内代码及未选择的 `@` 保持普通文本。手机 Enter 换行，使用按钮发送。

Selected files retain `@` and a blue highlight in the existing editor. `$` skill references keep their own names, paths and green highlight. Both remain atomic when selected/deleted and retain their independent identities through other edits, native undo, conversation navigation and planned-update draft recovery. Replacing a reference's text removes its binding. Drafts keep the existing in-memory lifetime: ordinary reloads do not save composer drafts. A failed or uncertain send preserves the draft and does not automatically resend. Selected references cannot accompany slash commands; `//` still sends a literal leading slash.

所选文件在原输入框内保留 `@` 和蓝色高亮；`$` 技能保留独立名称、路径及绿色高亮。两类引用均支持整体选择/删除，在其他编辑、原生撤销、切换会话及计划更新恢复中保持各自身份。替换引用文字会解除绑定。草稿沿用现有内存生命周期，普通刷新不会保存输入内容；失败或回执未知时保留草稿且不自动重发。已选引用不能携带到 slash 命令；`//` 仍用于发送开头的字面量斜杠。

## Server scope and limits / 服务器范围与限额

The gateway determines the real cwd from the conversation's server-owned workspace, or the selected registered project for a new draft. An unassigned draft reserves a dedicated directory reused by first-message creation. Clients cannot supply search roots or override cwd. Only regular files beneath that cwd are offered. Parent traversal, absolute paths, all symbolic links (including internal aliases), nested registered project roots, and other managed workspaces are excluded. Removed nested registrations retain their boundary. Selected files are checked again for scope, existence and readability immediately before dispatch.

网关从会话的服务器工作区决定真实 cwd；注册项目的新草稿使用所选项目目录，未关联项目的新草稿预留独立目录并在首条消息创建时沿用。客户端不能指定搜索根目录或覆盖 cwd。仅提供该 cwd 下的普通文件；禁止上级越界、绝对路径、所有符号链接（含内部别名）、嵌套注册项目及其他受管会话目录，移除后的嵌套注册也保留边界。发送前重新检查所选文件的归属、存在性和可读性。

Search uses Codex's native `fuzzyFileSearch`, including its ignore/ranking behavior and maximum 50 matches. Covro debounces queries by 160 ms, permits four concurrent native searches, sets a five-second deadline and cancels old work with a unique native cancellation token when the browser aborts. Query, caret, draft, workspace and runtime identities gate visible results. A limit message asks for a narrower path. A message can contain up to 32 selected file references. Empty, unreadable, offline and timed-out requests have separate states and retain the draft; Reload retries the current search. Upstream search can suppress traversal errors into an empty list, so its empty response cannot prove every subtree was readable.

搜索复用 Codex 原生 `fuzzyFileSearch`，沿用其忽略规则、排序及最多 50 条候选。Covro 使用 160 ms 防抖、最多 4 个并发原生查询及 5 秒期限；浏览器取消请求时，以独立原生取消令牌停止旧工作。查询、光标、草稿、工作区和运行时身份共同隔离可见结果。达到限额时提示细化路径，每条消息最多选择 32 个文件引用。空结果、不可读、离线与超时分别反馈，均保留草稿，可重新加载。上游可能将遍历错误转为空列表，因此空结果不表示每个子目录均可读取。

Node's portable file APIs cannot make parent-directory replacement race-free. Covro verifies canonical paths and opened inode identity, rejects symlinks, and rechecks workspace ownership; files can still change after validation while Codex reads them. References provide paths, not snapshots or automatically injected file bytes. Browser image attachments continue through `＋`/paste and the existing image limits. A workspace image selected with `@` is a path reference; the native TUI's automatic local-image attachment shortcut is not reproduced here.

Node 可移植文件 API 无法彻底消除父目录被并发替换的竞态。Covro 核对真实路径、已打开 inode 及工作区归属并拒绝符号链接；验证完成后、Codex 读取前文件仍可能变化。引用传递路径，不是文件快照，也不会自动注入文件字节。访问端图片继续通过 `＋`/粘贴及原有图片限额处理。通过 `@` 选择服务器图片时发送路径引用，本功能不复刻原生 TUI 自动将本地图片转成附件的快捷行为。

## Native protocol basis / 原生机制依据

The project targets **Codex 0.166.0**. The issue's original **0.164.0** baseline uses the same ordinary-file completion semantics: [`insert_selected_path` in 0.164.0](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/bottom_pane/chat_composer.rs#L2779) and [0.166.0](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/tui/src/bottom_pane/chat_composer.rs#L2812) insert a path into text, quoting whitespace unless the path already contains a double quote. They do not create a file `UserInput.mention` attachment. [`search.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/search.rs) cancels a previous search with the same token; an empty query ends it without a new scan. [`fuzzy_file_search.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/fuzzy_file_search.rs) fixes the native result limit at 50.

当前项目目标为 **Codex 0.166.0**。Issue 原始 **0.164.0** 基线的普通文件补全语义相同：将路径写入文本；含空白时加双引号，但路径本身含双引号时沿用原文。Covro 只在草稿中保留 `@` 对象，服务器校验后转换为上述路径文本，再走正常 `turn/start` 或 `turn/steer`；技能仍是独立 `skill` 输入项，文件不使用 Apps 的 `mention` 类型。不新增 `/mention`，#69 的该项保持 🚫。

[Official prompting guidance](https://learn.chatgpt.com/docs/prompting) describes `@` path completion at a high level; the tagged source and checked-in generated protocol establish this implementation's wire semantics. Tests using the repository fixture verify request shape and actual page behavior, not real model file-reading quality. See [the verification record](file-references-verification.md) for the exact checks and remaining native verification boundary.

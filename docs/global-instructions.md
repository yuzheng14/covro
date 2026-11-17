# 全局 AGENTS.md

入口：「设置 → 全局指令」。读取、编辑或创建 Covro 当前 Codex 环境的全局 `AGENTS.md`，不需要先添加项目。界面显示实际文件路径。

路径按 Covro 配置 `codex.home`、服务进程的 `CODEX_HOME`、默认 `~/.codex` 的顺序确定。这是服务器运行用户的全局指令，不是浏览器所在电脑的文件。使用相同 Codex home 的其他客户端也会受到影响。

- 不在界面编辑项目指令，也不会删除或修改项目已有的 `AGENTS.md`。Codex 自身仍可加载项目指令。
- 保存不会重启任务，也不会保证已有会话自动更新；建议新建会话使用修改后的指令。
- 非空 `AGENTS.override.md` 优先于 `AGENTS.md`。检测到时，编辑器显示提示并禁止保存，避免误以为修改已生效；不会自动更改 override 文件。
- 支持不超过 256 KiB 的普通 UTF-8 文本文件，不编辑符号链接、硬链接或二进制文件。Codex 自身仍有独立的指令加载大小限制。
- 保存进行版本核对并提示外部改动冲突，保留未保存内容；可复制修改后重新读取。关闭、重新读取或离开页面时提醒未保存的修改。
- 保存不自动创建 Git 提交；全局文件通常位于项目仓库之外。

# Global AGENTS.md

Open **Settings → Global instructions** to read, edit, or create the global `AGENTS.md` used by Covro's Codex environment. No registered project is required. The editor displays the actual server-side path.

The directory is resolved from `codex.home`, then the service process's `CODEX_HOME`, then `~/.codex`. Other clients using that same Codex home share the instructions. Existing project instruction files remain untouched and Codex can still load them. Start a new conversation to ensure changed guidance is loaded.

A non-empty `AGENTS.override.md` takes precedence; the editor warns and disables saving without changing the override. Regular UTF-8 files up to 256 KiB are supported, with revision checks, conflict messages and unsaved-change prompts. Codex's own instruction-loading size limits still apply. Saving neither restarts tasks nor creates a Git commit.

# Restarting the Covro service · 重启 Covro 服务

## Use the web control

On macOS or Linux, open **Settings → Service settings → Restart Covro** and select **Restart when idle**. This works with the same release and independently of update availability. Save any edits in Service settings first. The restart loads the saved Covro and Codex configuration from disk. Existing conversations keep their saved settings where Codex gives those settings precedence.

Covro shows what is keeping it busy. Running sessions, approvals, input requests, Git clones, shell commands, model capacity retries, unconfirmed operations, and service maintenance can delay the restart. Resolve approvals and input, and reconcile old operations where needed. You can close Settings or the browser while waiting. Reopen Service settings to see the same request or cancel it before shutdown starts. Covro checks for idle again before closing admission to new work. A request expires after 30 minutes of waiting.

Keep the workspace tab open while Covro reconnects. The workspace resumes its existing live subscription to the selected conversation and keeps the composer and unsent attachments in memory. Covro reads existing operation receipts and history on reconnect. Sending the draft still requires pressing Send. Other tabs see the same service restart, each with its own selected conversation and draft.

## Support and recovery

- The web control supports POSIX process replacement for `covro run` and its Covro-managed background and login launches on macOS and Linux. It reuses the original launch arguments, process ID, working directory, environment, configuration file and data directory. The old managed app-server exits before Covro starts a new one. Other Covro instances and separately started Codex CLI or IDE processes keep running.
- Direct server entry points, development mode and Windows use their original service controls. Use those controls as well when changing the data directory, bind address, port, public origins or authentication settings. Those changes can move the instance away from the active browser or change who can connect.
- The service records each restart and verifies a new Codex app-server handshake before showing success. When the connection stays down for 90 seconds, the browser reports that it has not reconnected. Check `covro status --config FILE` and `covro logs --config FILE` on the host. The restart ID under **Technical details** matches the structured restart events. Startup errors are logged under `daemon.start_failed` or `codex.start_failed`. If the service is stopped and its startup configuration is corrected, start it using the original launch method.
- Pending approvals, tasks that need reconciliation, or maintenance that needs repair require their normal controls. The web restart does not offer an option to interrupt them.

## 网页操作

在 macOS 或 Linux 上打开 **设置 → 服务配置 → 重启 Covro**，选择 **空闲后重启**。同一版本和没有可用更新时也可以使用。先保存服务配置中的编辑，重启会从磁盘读取已保存的 Covro 和 Codex 配置。已有会话仍遵循 Codex 对会话设置的优先级。

等待期间会显示执行中的会话、待处理的审批或输入、Git 克隆、Shell 命令、模型容量重试、待核对的操作或服务维护。可以关闭设置或浏览器，之后回到服务设置查看同一笔请求，或在开始关闭服务前取消。Covro 在阻止新操作前再次确认空闲，等待超过 30 分钟时请求过期。

重启时保留工作区标签页，恢复后会自动重新订阅原会话并读取历史和操作回执。编辑器中的未发送文字和附件仍保留在标签页内，发送草稿需要再次由用户操作。其他标签页看到相同的重启进度，分别保留各自的会话和草稿。

## 支持范围与排障

- 支持 macOS 和 Linux 上通过 `covro run` 以及 Covro 自带的后台和登录启动方式运行的实例。重启保留原进程 ID、启动参数、工作目录、环境、配置文件和数据目录，等待原受管 app-server 退出后再启动新实例。独立 CLI、IDE 和其他 Covro 实例继续运行。
- 直接运行网关、开发模式及 Windows 使用原有服务控制方式。更换数据目录、监听地址、端口、公开访问源或认证配置时，也使用原有控制方式，以便按新地址或认证方式重新连接。
- Covro 确认新的 Codex app-server 握手后报告成功。浏览器 90 秒连不上时显示尚未恢复。在宿主机上用同一个配置文件执行 `covro status --config FILE` 和 `covro logs --config FILE`，以技术详情中的重启 ID 匹配结构化日志。启动失败可查找 `daemon.start_failed` 或 `codex.start_failed`。若服务已停止，修正配置后用原启动方式恢复。
- 用原有控件处理审批、核对未确认的操作或修复维护任务。网页重启只在空闲时执行。

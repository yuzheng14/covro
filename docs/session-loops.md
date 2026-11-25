# Session loops

Use `/loop 5m Check the current PR's CI status` in a saved Covro session. A bare `/loop` opens the session's loop manager. It shows the prompt, interval, last result, and next run, and lets you create, pause, resume or cancel a loop. The command accepts whole numbers followed by `m`, `h` or `d`, from `1m` through `1d`. The first run is due after one interval. A loop runs until paused or cancelled.

Covro schedules runs on the server, so the browser may be closed. The prompt starts a regular turn in the same session, using the settings selected at creation and the normal workspace and permission checks. Approval and input requests are handled in the conversation. The scheduler waits while the session is busy, has unanswered requests, or has a capacity retry pending. A manual send already submitted to the gateway takes priority. When several ticks become due during one busy period, each loop has only one pending run. After dispatch, its next due time is one interval later.

Pause and cancel stop future dispatches and leave any current turn running. Use `/stop` to interrupt that turn. Resume schedules the next run one interval later. Capacity retries are part of the originating run. A failed run appears in the loop manager and in the conversation if Codex created a turn.

While an update or manual restart is waiting for the service to become idle, the scheduler yields. Active turns finish under the normal idle rules. After a server restart, Covro skips missed intervals and resumes the saved session on demand. A dispatch whose result cannot be confirmed is held for reconciliation before the loop can be resumed. Archiving a session pauses its loops. Unarchive the session before resuming them. A confirmed missing session is cancelled, and a fork does not inherit loops. The host and Covro service must be available for scheduled runs to start.

## 会话循环

在已保存的 Covro 会话中输入 `/loop 5m 检查当前 PR 的 CI 状态`。单独输入 `/loop` 打开当前会话的循环管理，查看任务、间隔、上次结果和下次时间，并可新建、暂停、恢复或取消。间隔使用整数和 `m`、`h`、`d`，范围为 `1m` 到 `1d`。创建一个间隔后首次执行。循环持续运行，直到暂停或取消。

服务端负责调度，关闭浏览器后仍能运行。每次在原会话中发起普通轮次，使用创建任务时选择的设置，并经过现有工作区和权限检查。审批和回答继续在会话里处理。会话忙碌、有未处理的请求或正在等待容量重试时，循环等待。先到达服务端的手动发送优先。忙碌期间多次到期只保留一次，派发后从实际派发时间重新计算下次时间。

暂停或取消会停止后续派发，当前轮次可以继续执行。用 `/stop` 中断当前轮次。恢复后等待一个间隔再执行。容量重试记在同一次运行里。失败可在管理窗口查看，Codex 已创建的轮次也保留在会话中。

更新或手动重启一旦进入空闲等待，循环停止派发，已经开始的轮次按正常规则结束。服务重启后跳过停机期间错过的触发点，在到期时恢复原会话。派发结果无法确认时先核对，再恢复循环。归档会暂停循环，取消归档后可手动恢复。确认会话已不存在时，任务会被取消。Fork 创建的新会话不继承循环。运行仍依赖 Covro 服务与宿主机可用。

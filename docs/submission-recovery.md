# Recover an unconfirmed submission

[简体中文](#简体中文)

Covro checks submissions automatically after reconnecting, reopening a conversation, or returning to the page. If the result can be confirmed, normal controls recover without intervention. Checking never resends a message or answers an approval.

If an operation still blocks sending or an approval, use **View recovery options** beside that control. The panel identifies the operation, time, project and conversation. Other conversations appear separately; **Open conversation** takes you to their history. IDs, paths and raw errors are under **Technical details**.

- **Check again** queries the original submission and execution evidence.
- **Remove this page’s restriction** is offered only when the server explicitly cannot find a record and this browser has no valid receipt. Its confirmation removes only that browser record. It does not stop a task or resend anything; the original operation might have executed, so submitting it again could duplicate it.
- **Restore conversation controls** asks you to inspect that conversation’s history and confirm the previous task ended. The server checks the original execution and refuses to release a known active task. It cannot release a later task’s reservation.
- An active task must be viewed or stopped in its own conversation. An approval waiting for an answer is different from an answer currently being submitted: a missing answer receipt can be cleared locally without stopping the task. Approvals already answered or expired are never re-enabled.

When the name cannot be read, the saved name is used where available. Older approval records may have no conversation reference; Covro says so rather than attributing them to the selected conversation. Temporary query failures do not enable local removal. If evidence is still unavailable, checking remains conservative and the original submission is never replayed automatically.

## 简体中文

Covro 会在重新连接、打开会话和返回页面后自动核对提交。能够确认结果时，操作入口自动恢复，无需人工处理；核对不会重新发送消息或自动回答审批。

发送或审批仍被阻塞时，点击旁边的「查看处理方式」或「核对提交」。面板显示具体操作、时间、项目与会话；其他会话单独分组，可点击「打开会话」查看对应历史。ID、路径和原始错误放在「技术详情」中。

- 「重新检查」查询原提交及其执行证据。
- 「解除本页限制」仅在服务端明确找不到记录、且浏览器没有有效回执时提供。确认后只移除当前浏览器的该条记录，不会停止任务或重新发送。原操作可能已经执行，再次提交可能重复执行。
- 「恢复此会话的操作」要求先查看对应历史并确认旧任务已结束。服务端仍检查原执行身份，拒绝释放已知的活动任务，不会解除后来任务的占用。
- 活动任务应在所属会话查看或停止。等待审批和正在提交审批答案是不同状态：缺失的答案回执可在确认后清除本地限制，无需停止正在等待审批的任务；已回答或已失效的审批不会重新启用。

无法读取名称时，尽可能使用已保存的名称；旧审批记录可能没有保存会话归属，页面会明确说明，不会误指当前会话。临时查询失败不会开放本地清理。缺少可靠证据时仍保留必要限制，始终不自动重发原操作。

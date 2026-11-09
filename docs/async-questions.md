# Questions and answers / 提问与回答

Codex can ask questions while continuing its task. Choose an option or write a custom answer, then send the form explicitly. The initial selection is never submitted automatically. Questions, choices and recorded answers display Markdown, including emphasis, code, links and paragraphs. Opening a link does not select an option or send an answer.

Answers stay attached to their original question when you reload, resume or fork a conversation. Formatting changes only the display; the original question and chosen answer are sent to Codex. If a send fails, your input stays available. An uncertain receipt does not automatically send the answer again.

Codex 可以在继续执行任务时提问。选择选项或输入自由回答后，明确点击发送；默认选中不代表已经提交。问题、选项和已发送的回答支持 Markdown，包括强调、代码、链接和段落。打开链接不会选择选项或发送回答。

刷新、恢复或 Fork 会话后，已发送的答案仍与原问题关联。格式仅影响显示，提交给 Codex 的仍是原始问题和所选答案。发送失败会保留输入；回执不确定时不会自动重发。

For a native waiting-input request, skip individual questions and explicitly submit the form, or choose **Skip all and submit**. Codex receives empty answer lists for the skipped questions and continues handling the current task. This does not interrupt the task.

For a question marked **You can answer later**, **Skip** stops Covro reminders for that question without sending an answer or creating a turn. **Skip all** applies to every unanswered question in that card, including filled drafts: it does not submit any of them. To answer only some questions, skip the others first, then choose **Send answer**. Recorded answers and skipped questions stay in history after reload or restart. Other cards and running tasks keep their own state. This is a persistent Covro reminder setting, not a native cancellation request. Covro checks for answers from another client and blocks competing changes while an answer is submitting or its receipt is uncertain. Saved native requests that no longer have a live callback are shown as expired, never reopened as pending.

对于原生等待输入请求，可以逐题选择跳过后明确提交，也可以选择“全部跳过并提交”。Codex 收到对应题目的空答案数组后继续处理当前任务；这不会中断任务。

对于标记“可稍后回答”的问题，“跳过”只停止 Covro 对该题的提醒，不发送回答、不创建新轮次。“全部跳过”作用于这张卡片里所有尚未回答的问题，包括已填写的草稿，不会提交其中任何回答。如果只想回答部分问题，先逐题跳过不答的问题，再点击“发送回答”。已有的回答记录和跳过记录在刷新、重启后保留，其他卡片和执行中的任务各自独立。这是 Covro 持久化的提醒设置，不是向原生 Codex 发送取消请求。Covro 会核对其他客户端的回答；回答提交中或回执不确定时，暂不允许竞争操作。已没有有效回调的原生请求以失效历史展示，不会重新成为待答请求。

Version-specific source, native CLI checks and limitations: [question disposition research](questions-302-research.md).

# Skills / 技能

Open **Skills** in the top toolbar to browse Codex's discovered skills for the current conversation or draft. Search names, original descriptions, paths, scopes, and plugin sources; read descriptions in the list and expand an entry for its full description and actual `SKILL.md` path. Duplicate names remain separate. **Reload** bypasses Codex's discovery cache; discovery errors appear alongside valid entries. Disabled skills remain visible with their upstream status. The browser does not install, create, edit, or enable skills, and there is no `/skills` command.

在顶部工具栏打开**技能**，浏览 Codex 为当前会话或草稿发现的技能。可搜索名称、原始说明、路径、作用域和插件来源；列表展示简介，展开条目查看完整说明及实际 `SKILL.md` 路径。同名技能分别展示。**重新加载**绕过 Codex 的发现缓存；部分发现错误与有效条目同时显示，禁用项保留上游状态。本界面不安装、创建、编辑或启停技能，也不新增 `/skills`。

Discovery uses native `skills/list` from Codex 0.164.0. The gateway resolves the real server cwd and never scans the browser's filesystem or accepts a browser-supplied cwd. Unassigned drafts reserve a dedicated server directory reused by first-message creation. Conversation/project/runtime changes invalidate visible results; offline and unavailable reads retain a refresh entry point.

技能发现使用 Codex 0.164.0 原生 `skills/list`。网关解析服务器真实 cwd，不扫描浏览器本机，也不接受浏览器传入任意 cwd。未关联项目的草稿预留独立服务器目录，首条消息创建时沿用。切换会话、项目或运行实例后旧结果立即失效；离线或不可用时保留刷新入口。

## Explicit references / 显式引用

Type `$` at the start of the input or after whitespace/an opening bracket to search available skills. Arrow keys choose an entry; Enter or Tab selects it. Escape closes the suggestions without changing text. Touch users select an entry and use the send button; mobile Enter inserts a newline. Candidates show original names, descriptions, scopes and compact source paths; hover for the full path. Same-name sources remain distinct. Selected references are highlighted inside the input. Backspace immediately after one removes the whole reference; arrow keys move across it as a unit. Full selected paths remain available to assistive technology and in the focused reference tooltip.

在输入开头、空白或左括号后输入 `$` 搜索可用技能。方向键切换，Enter 或 Tab 选择，Escape 取消且保留原文。触屏点击候选后使用发送按钮，手机 Enter 保持换行。候选展示原始名称、说明、作用域及精简来源路径，悬停可查看完整路径，同名来源保持区分。已选引用直接在输入框文字中高亮；紧接引用后按一次退格键可整体删除，方向键将其作为整体跨过。完整路径保留在辅助技术说明及选中引用的悬停提示中。

Selection binds the original name, path and server cwd to that token in the existing project/conversation draft. Native selection and deletion keep a reference whole; replacing its text removes the old binding. Other edits, images and draft switching preserve intact references. Confirmed sends clear the submitted references; failed or uncertain sends retain them without automatically resubmitting. Drafts follow the existing in-memory lifetime and planned-update recovery; ordinary page reloads do not persist composer drafts.

选择后，引用以真实 name、path 和服务器 cwd 绑定到文本标记，并保存在现有项目/会话草稿中。原生选区和删除保持引用完整，替换其文字会解除原绑定；其他编辑、图片及草稿切换保留完整引用。确认发送后清理已提交引用，失败或回执未知时保留且不自动重发。草稿沿用现有内存生命周期及计划更新恢复机制，普通页面刷新不持久化输入框草稿。

First messages and subsequent idle-conversation messages send `$<name>` text plus native `{ type: "skill", name, path }` inputs. The gateway refreshes the same native discovery source and rejects unavailable/disabled identities, changed cwd, absent markers and arbitrary host paths before dispatch. Literal dollars and unmatched/dismissed suggestions remain ordinary editable text. Slash commands cannot carry selected references.

首条消息和已有空闲会话均发送 `$<name>` 文本及原生 `{ type: "skill", name, path }`。网关发送前刷新同一原生发现源，拒绝不可用或禁用项、变化的 cwd、缺失标记和任意主机路径。普通字面量 `$`、无匹配或取消选择均保持可编辑文本；slash 命令不能携带已选引用。

Protocol: [official App Server skills](https://learn.chatgpt.com/docs/app-server) and [0.164.0 steering implementation](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/turn_processor.rs). A real 0.164.0 turn/start smoke test selected the second of two same-name probe skills and received only that path's hidden instruction marker. Although the steering schema maps skill items through `V2UserInput::into_core`, a separate real active-steering test did not inject the selected skill's instructions. Covro therefore blocks active submissions containing selected references, with an explicit message, and retains the draft until the current task ends. The gateway also rejects such requests before dispatch; ordinary text/image steering remains available.

真实 0.164.0 的 turn/start 验证已确认同名技能的第二个实际路径生效；但运行中 turn/steer 虽接受 skill 输入项，独立真机验证没有注入其指令。因此运行中携带已选引用时明确提示等待任务结束，并保留草稿；网关在派发前也拒绝这类请求。普通文本/图片追加仍可使用。

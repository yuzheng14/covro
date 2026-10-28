# Skills / 技能

Open **Skills** in the top toolbar to browse Codex's discovered skills for the current conversation or draft. Search names, original descriptions, paths, scopes, and plugin sources; read descriptions in the list and expand an entry for its full description and actual `SKILL.md` path. Duplicate names remain separate. **Reload** bypasses Codex's discovery cache; discovery errors appear alongside valid entries. Disabled skills remain visible with their upstream status. The browser does not install, create, edit, or enable skills, and there is no `/skills` command.

在顶部工具栏打开**技能**，浏览 Codex 为当前会话或草稿发现的技能。可搜索名称、原始说明、路径、作用域和插件来源；列表展示简介，展开条目查看完整说明及实际 `SKILL.md` 路径。同名技能分别展示。**重新加载**绕过 Codex 的发现缓存；部分发现错误与有效条目同时显示，禁用项保留上游状态。本界面不安装、创建、编辑或启停技能，也不新增 `/skills`。

Discovery uses native `skills/list` from Codex 0.164.0. The gateway resolves the real server cwd and never scans the browser's filesystem or accepts a browser-supplied cwd. Unassigned drafts reserve a dedicated server directory reused by first-message creation. Conversation/project/runtime changes invalidate visible results; offline and unavailable reads retain a refresh entry point.

技能发现使用 Codex 0.164.0 原生 `skills/list`。网关解析服务器真实 cwd，不扫描浏览器本机，也不接受浏览器传入任意 cwd。未关联项目的草稿预留独立服务器目录，首条消息创建时沿用。切换会话、项目或运行实例后旧结果立即失效；离线或不可用时保留刷新入口。

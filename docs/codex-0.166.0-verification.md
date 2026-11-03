# Codex 0.166.0 升级验证

日期：2026-11-02（Asia/Shanghai），对应 [#301](https://github.com/yuzheng14/covro/issues/301)。协议来源、完整包校验值和实验边界见 [协议审查](codex-0.166.0-protocol.md)，机器可读结果见 [结果记录](codex-0.166.0-results.json)。本轮没有新增 npm 依赖或修改锁文件。

## 验证层次

真实 **0.166.0 + 全新 CODEX_HOME + 本地 HTTP 模型 stub**：

- `scripts/verify-codex-upgrade.ts --expected-version 0.166.0` 验证 legacy/paginated 原生 rollout 压缩、冷恢复、最后一轮后的模型/effort/tier 与审批策略确认、网络权限保存、显式覆盖、两进程 writer conflict、普通 Fork 血缘/消息、命名 profile 收紧、工具禁用的临时自动标题及压缩失败后继续对话。没有编辑 rollout 内容或内部数据库。
- `scripts/verify-live-settings.ts --expected-version 0.166.0` 验证首个模型请求在途时 Fast 发布、后续步骤携带 priority、模型/强度本轮不变，审核方发布保留已有人工审批并明确拒绝，下轮采用新模型/强度与清除 Fast。
- `scripts/verify-codex-166.ts` 验证 legacy/paginated 的 modelNotFound 与 policyCapacityUnavailable：无重试建议时仅一个实际模型请求、willRetry=false、failed 终态与历史保留错误；删除保存的 provider 配置后冷恢复拒绝并保留结构化原因；GCP account/read 不依赖 ChatGPT 认证，也不解析 provider 凭证。没有真实 Vertex 推理。

fixture 单元/集成另外覆盖容量有限续跑保护、非容量错误不重试、provider data 白名单/未知回退、账号切换不复用旧额度、flat item 时间缺失/null 和图片两种结果。上游原生停止重试与 Covro 的有限空输入续跑是不同层次，保留原生已 retry/已有进展/结果不明等保护。

真实账号推理使用独立 CODEX_HOME，仅复用现有认证，不复制默认历史、全局配置或 MCP，不打印凭证：

- `pnpm test:live -- --inference`：握手、账号和 8 个模型查询；实际创建 smoke.txt 并核对精确内容，文件变更、继续对话、历史列表、无事件订阅时同一 app-server PID 均通过。本轮没有 shell 输出，不把文件变更算作命令输出验证。
- `scripts/live-upgrade-interactions.ts --expected-version 0.166.0 --inference`：活动 nested shell 期间 expectedTurnId 追加，Code Mode/nested shell 中断的真实终态，结束后追加拒绝，立即下一轮，以及人工命令审批拒绝和旧回复失效均通过。没有自动批准测试操作。

## 本地检查与界面

目标协议和行为更新后，typecheck、lint、build、**1448 项单元/集成测试通过，1 项原有跳过**。异步问题 Markdown 的桌面/390px 原始提交载荷、链接不选择/不发送、键盘原生 radio、已回答历史与刷新回归 7 项通过。49 项相关浏览器回归 46 通过、3 项下述既有焦点失败；CI 结果以对应 PR 的最终记录为准。

本机账户额度弹窗的四语 Tab 焦点断言出现既有失败；未修改 main 的临时快照也复现同一断言失败（en/ja/ko，另一次记录涉及 zh-Hans），没有放宽断言或修改无关弹窗逻辑。不能将这套本地浏览器检查写为全绿。

`scripts/verify-codex-browser.ts --inference` 通过生产前端和真实网关提交任务并收到精确回复，已捕获 1280px / 390px 实际 CLI 页面；真实页面截图分别标注实际 CLI 与显式 fixture；异步问题提供 main 原样展示和 Markdown 展示的对照。Browser Use 当前未连接可用浏览器，返回 native pipe startup failed，Chrome/iab 均不可用；因此暂未上传到 GitHub PR 评论，**本地 PNG 不等于完成截图交付要求**。保持 PR 草稿，待连接后上传并确认图片可显示。

## 部署、回退与边界

该候选包的单一 recommended / verified 为 0.166.0。隔离验证没有升级全局 CLI；部署时显式选择完整目标安装后重启网关。回退到 0.164.0 或其他未列出的版本会进入 unverified 确认，不沿用旧 epoch 确认，也不自动重发任务。若需同时声明多个 verified 版本，应另外验证矩阵。

系统受管策略/逐域代理、真实 GCP、原生 spawned 后代批量取消归档、长时间自动卸载、实际 reasoning-token 压缩阈值、真实长期 goal 和远程 Tunnel 没有全部端到端重测。相关传输/投影边界由 fixture 与已有回归覆盖，不将上游修复或模型 stub 结果写成目标环境实测。未知错误继续回退，不猜测为占用或授权。

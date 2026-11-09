# Codex 0.167.0 升级验证

日期：2026-11-09（Asia/Shanghai），对应 [#327](https://github.com/yuzheng14/covro/issues/327)。来源及稳定/实验差异见 [协议审查](codex-0.167.0-protocol.md)，机器可读结果见 [结果记录](codex-0.167.0-results.json)。本次复用已有完整安装、项目依赖和浏览器，没有下载新依赖或修改锁文件。

## 改动与声明

- 声明 requiredHumanApproval；humanCommand 只提供并接受一次 accept/decline/cancel，拒绝 session、命令规则、网络规则及 persist。原始请求保存在服务端，修改浏览器投影不能扩大决定范围；重复待处理 RPC 保留同一 action，上游 resolved 后旧回答失效。标题同步四语，普通审批保留原有选项。
- 列表和归档核对显式传 modelProviders: []，保留 cwd/sourceKinds/分页边界。provider 不匹配仍拒绝恢复，历史可读，不自动切换 provider 或重发原任务。
- 稳定协议与推荐/单一 verified 基线同步提升至 0.167.0；live-settings 的精确版本门禁也提升至 0.167.0。原生 feature、模型能力与 applied 回执仍分别检查；模型/强度保留下轮生效语义。

仓库打包校验要求 recommended 与生成协议版本一致，因此分为“人工审批 → 历史查询 → 协议与运行基线”三个 PR。前两层保留 main 的 0.166.0 声明，栈顶同时更新协议和推荐/verified，不放宽校验。

## 真实 binary 与本地模型 stub

每个探针显式指定已有 0.167.0 binary，使用全新 CODEX_HOME、本地 HTTP Responses stub 与临时项目，不加载真实认证或默认历史。

- `verify-codex-upgrade.ts --expected-version 0.167.0`：legacy/paginated 原生 rollout 压缩、冷恢复、最后一轮后确认的模型/effort/tier/权限/网络设置、显式覆盖、两个进程 writer conflict、普通 Fork、工具禁用的自动标题、命名 profile 收紧、压缩失败后继续对话，以及跨项目/嵌套可信目录的配置读取均通过。未手写 rollout 或内部数据库。
- `verify-live-settings.ts --expected-version 0.167.0`：首个模型请求在途时 Fast 发布、后续实际请求携带 priority、模型/强度本轮不变、审核方发布保留既有人工审批并显式拒绝、下一轮采用新模型/强度并清除 Fast 均通过。
- `verify-codex-166.ts --expected-version 0.167.0`：复用前次错误/准入探针，覆盖两种历史模式中的 modelNotFound、policyCapacityUnavailable 终态及历史，移除已保存 provider 后冷恢复拒绝并保留结构化原因；GCP account/read 不依赖 ChatGPT 认证。脚本保留原 0.166.0 默认值，目标验证必须显式传版本。
- `verify-provider-history.ts --config <目标配置>`：原生创建并归档 legacy/paginated 历史，切换 provider 后重启；活动/归档发现、准确归档状态、精确 cwd、完整已保存文本和 modelProviderMismatch 拒绝均通过。可选 `--output-dir` 经生产前端验证旧 provider 的活动/归档会话可见、文本可读并拍摄截图。
- `verify-managed-mcp.ts --binary <目标 binary>`：原生 MCP 写入审批拒绝、Code Mode 工具发现、同 app-server 创建并提交子会话、Web 继续会话无 writer conflict、重启后重新注入、配置文件不变、关闭清理与独立客户端隔离均通过。npm/MCP SDK 和浏览器沿用现有依赖。

## 真实账号与页面

独立 CODEX_HOME 仅复用现有认证，不复制默认历史、配置或 MCP，不输出凭证。

- `live-smoke.ts --inference`：握手、账户与 8 个模型查询；实际创建 smoke.txt 并核对精确内容、文件变更、继续对话、历史发现，以及无订阅期间同一 app-server PID 均通过。此次未观察到 shell 输出，不把文件变更当成命令输出验证。
- `live-upgrade-interactions.ts --expected-version 0.167.0 --inference`：活动 nested shell 期间 expectedTurnId 追加、Code Mode/nested shell 中断的真实终态、结束后追加拒绝、立即下一轮、人工命令审批拒绝和旧回答失效均通过。
- `verify-codex-browser.ts --inference`：生产前端、真实网关、真实 0.167.0 收到精确回复，1280px/390px 实际页面通过，窄屏无横向溢出。截图与显式 fixture 的 humanCommand 截图分开标注。

## 本地检查与截图

完整单元/集成测试 **1527 通过、1 项原有跳过**；相关 Chromium 浏览器回归 **75 项通过**，覆盖普通/人工/额外权限/MCP 审批、重连、兼容确认、live-settings、刷新、离线、手机布局，以及最新 main 的原生问题跳过和跟踪持久化。分层重排后追加的 adapter/协议/兼容检查 114 项通过。typecheck、lint、格式检查、build、数据库声明、兼容块、生产产物、npm 打包与升级/回退检查通过；npm 传输在升级 worker 检查中为明确的本地 fixture，没有实际安装或发布 npm 包。

humanCommand 的桌面/手机截图已通过 Browser Use 上传并确认可显示：[审批层截图评论](https://github.com/yuzheng14/covro/pull/331#issuecomment-6731147629)。历史查询层和栈顶真实 CLI 页面截图也已上传并确认显示：[历史查询层](https://github.com/yuzheng14/covro/pull/332#issuecomment-6731350180)、[栈顶真实 CLI](https://github.com/yuzheng14/covro/pull/330#issuecomment-6731421327)；以 PR 最终检查和评论为准，不把本地路径当成上传完成。

## 边界与回退

**受管 prompt-user 检查点尚未在系统/组织受管环境中实测。** 实际检查确认临时 CODEX_HOME 下的 requirements.toml 不会成为受管策略源；本轮未修改主机的系统配置或 MDM。该路径按精确上游契约和 fixture 验证三种决定、伪造复用授权、重放、撤回及迟到回答；真实普通命令的审批拒绝不能替代该受管检查点验证。

逐域网络代理及同 endpoint 并发排队、requirements.toml 新网络写法的真实受管部署、长时间活动分页消息的内存释放、失败响应缺失 usage 的实际自动压缩阈值、真实 GCP/远程 backend/音频输入、手机真机和长期 goal 没有全部端到端重测。网络 resolved 的卡片撤回和旧回复由 fixture 覆盖；ThreadSectionChanged 明确忽略，不新增原生 section 管理；音频只保留类型占位，不承诺上传/播放；不整包透传遥测或 MCP metadata。

部署时显式选择完整 0.167.0 安装并重启网关，本次验证未升级默认 CLI 或配置。候选只声明 0.167.0；回退到 0.166.0 或其他版本会进入 unverified 确认，不沿用旧 epoch 确认，不自动重发任务。若要同时列出多个 verified 版本，需另做独立矩阵。

# Codex 0.170.0 升级验证

日期：2026-11-18（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。这是 [原生 Stack #360](https://github.com/yuzheng14/covro/pull/360) 的累计目标更新，审查顺序仍为 #355 → #356 → #357 → **#359（最终整栈合并入口）**，尚未合并或发布。协议差异见 [审查记录](codex-0.170.0-protocol.md)，机器结果见 [结果 JSON](codex-0.170.0-results.json)。

## 候选与检查

候选同步到 main `ae9a2e0`，包含已合并的后台克隆功能，保留其 **DB Schema 11**；本轮没有增加数据库迁移、依赖或锁文件变更。recommended / 单一 verified 与 live-settings、provider 的精确门禁同时切换到 **0.170.0**，中间版本不加入 verified。

完整单元/集成测试 **1702 通过、1 项原有跳过**，新增答案展示 v1、未知版本受限与历史投影回归。相关 Chromium **179 项通过**（账户四语文件 7 项、其余会话/权限/历史/模型/升级等 162 项、设置选择器 10 项）。typecheck、lint、格式、build、数据库/双语兼容块、生产产物、npm dry-run 与升级/回退 worker 检查通过；npm 传输仅为本地 fixture，没有真实安装或发布包。最新 CI 与审查结果仍以 PR 为准。

账户四语键盘测试此前会在后台额度刷新仍占用按钮时按 Tab，形成随机焦点失败；测试现在先等刷新按钮可用，保留原有焦点与窄屏断言，四语文件 7 项重新通过，未修改产品行为或放宽断言。

CI 的窄屏长模型名称用例原先只替换全局模型列表，与新的 provider 目录不一致。现同时更新全局目录及 runtime-settings 已返回的 provider 目录，兼容中间层尚未激活最终版本门禁的状态，保留选中状态、保存与菜单边界断言。首层独立 worktree 与最终 0.170.0 栈顶的设置选择器文件均为 10 项通过，不重复计入总数。

## 真实 CLI 与本地 Responses stub

复用已有完整 0.170.0 安装和现有依赖/浏览器。每个探针使用独立临时 CODEX_HOME、项目、本地 HTTP endpoint，不加载默认历史或真实认证，不手改 rollout/内部数据库。

- `verify-codex-upgrade.ts --expected-version 0.170.0`：legacy/paginated 原生压缩、冷恢复、已确认设置、显式覆盖、writer conflict/释放、Fork 血缘、无工具标题、收紧的命名 profile、压缩失败续聊及嵌套 cwd 配置。
- `verify-live-settings.ts --expected-version 0.170.0`：请求在途时 Fast 发布，后续实际请求携带 priority；审核方更新保留已有人工审批并明确拒绝；模型/effort 下一轮生效并清除 Fast。
- `verify-codex-166.ts --expected-version 0.170.0`：两个历史模式中 modelNotFound、policyCapacityUnavailable、inferenceHookDenied、sessionBudgetExceeded 终态与历史；缺失保存 provider 的恢复拒绝、GCP account/read；可选输出目录捕获实际终止错误页面。
- `verify-codex-169.ts --expected-version 0.170.0`：默认 Code Mode 约 500 KB 输出有界截断；中断待文件审批 A、启动 B、迟到取消 A，B 完成且未写文件。
- `verify-codex-1691-providers.ts --expected-version 0.170.0`：真实 Mantle/Runtime/GCP 不同目录、新模型与默认排序、Runtime global/us ID、独立 ultrafast；Bedrock 默认增量工具与关闭开关、commentary/reasoning/tool 及最终答案重放；GCP 默认增量工具与关闭。认证值都是明确的 LOCAL_STUB_ONLY 虚构值；GCP 仅使用已有 Node 输出该值，凭证文件路径、AWS/OpenAI 环境认证均隔离。
- `verify-provider-history.ts --expected-version 0.170.0`：切换默认 provider 后活动/归档发现、精确 cwd、实际旧/新 endpoint、外部选择不写默认值。路由计数排除可并行的后台标题请求，避免把其他会话的 helper 误计为当前任务。生产前端 1280px/390px 及真实版本诊断截图通过。
- `verify-managed-mcp.ts --binary <目标 binary>`：MCP 写入拒绝、工具发现、同 app-server 子会话及续聊、重启注入、关闭清理、独立客户端隔离；标题与 recap 无工具执行，用户配置逐字节不变。

## 尚待完成

**真实账号外部推理未获明确授权，未执行。** 先前自动审批拒绝了复用现有认证发送外部模型请求，因为一般适配指令未明确包含该账号/凭证及外部推理流程；未发出该请求或使用额度，未使用的认证临时副本已删除。上述虚构认证 + loopback 不代替真实文件编辑、追加/中断、普通审批拒绝与真实模型页面冒烟。

**图片已生成、目视核对，但尚未发布到 PR 评论。** Browser Use 浏览器连接已恢复，实际 setFiles 上传失败，工具要求 Microsoft Edge 的 ChatGPT 扩展开启 “Allow access to file URLs”。需人类检查并启用该扩展权限后重试；未擅自扩大扩展权限，也没有通过其他途径绕过。失败的旧 0.169.1 评论草稿已清空，未发布旧截图。本地路径不算满足截图要求。

完整 V1/V2 模型与配置优先级矩阵、真实 Cloud 恢复、组织受管 prompt-user/代理、真实 OAuth/GCP/Bedrock、Windows 本机/手机真机、WebRTC、生物验证、全部超大 WebSocket/Code Mode 503/多媒体及 ID 历史组合未逐项实测。展示元数据由 fixture 验证，不能写成真实模型服务产生该元数据的证据。最新 CI 和人工审查完成前整栈保持 Draft。

## 回退

显式选择完整 0.170.0 并重启网关；本轮不替换用户默认 CLI 或全局配置。回退到 0.169.1、0.169.0、0.167.0 或其他版本会走 unverified 确认，不沿用旧 epoch 或自动重放任务。本轮 DB 声明继承 main 的 11，不能把旧 DB 10 历史记录当成候选数据库版本。

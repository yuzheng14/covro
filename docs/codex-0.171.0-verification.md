# Codex 0.171.0 升级验证

日期：2026-11-20（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。最终累计目标为 **0.171.0**，沿用 [原生 Stack #360](https://github.com/yuzheng14/covro/pull/360)：#355 → #356 → #357 → **#359（最终整栈合并入口）**。当前仍为 Draft，尚未合并或发布；此前 [0.170.0 验证](codex-0.170.0-verification.md) 保留为历史结果。

## 候选与本地检查

main 仍为 `ae9a2e0`，保留 **DB Schema 11**，未新增依赖、锁文件或迁移。本机 Node.js 24.22.1，复用已有完整 0.171.0 安装与锁定依赖/Chromium。recommended、单一 verified、provider 与 live-settings 精确门禁均为 0.171.0，中间版本不加入 verified。

完整单元/集成测试 **1704 通过、1 项原有跳过**；新增路由就绪通知刷新和 bioPolicy 不触发容量重试回归。typecheck、lint、build、数据库声明、双语兼容块、生产产物、402 文件的 npm dry-run 与升级/回退 worker 检查通过；npm 传输仅为本地 fixture，没有真实安装或发布包。生产验证初次被沙箱限制本地端口绑定，使用相同脚本在获准的沙箱外重新执行通过。

相关 Chromium 浏览器测试 **179 项通过**，覆盖账户四语、审批/MCP、兼容确认、升级、恢复/Fork/压缩、实时设置、provider 模型、键盘/窄屏、历史分页与标题。完整结果见 [机器结果](codex-0.171.0-results.json)。上一轮四层 PR 的 quality、八个浏览器分片与 verify 均已通过；这些属于旧提交结果，不能替代本轮最新提交的 CI。

## 真实 CLI 与本地模型 stub

以下均显式使用真实 **0.171.0** binary，隔离临时 CODEX_HOME、项目与 loopback endpoint，不加载真实认证或默认历史、不手改 rollout/内部数据库：

- `verify-codex-upgrade.ts`：15 项恢复、原生压缩、Fork、writer conflict、冷恢复覆盖、命名 profile 收紧、无工具标题和嵌套 cwd 配置检查。
- `verify-live-settings.ts`：Fast 在请求在途时发布，之后实际请求携带 priority；保留并明确拒绝已有人工审批，模型/effort 下一轮生效。
- `verify-provider-history.ts`：legacy/paginated 模式下旧/新 provider 的实际 endpoint、历史/归档/cwd、独立目录、thread-only 默认值边界；桌面与 390px 实际生产页面截图。
- `verify-codex-166.ts`：两种历史模式中 modelNotFound、policyCapacityUnavailable、bioPolicy、inferenceHookDenied、sessionBudgetExceeded 各一次终止与历史保留；缺失 provider 恢复拒绝、GCP 无 ChatGPT 认证的 account/read；终止错误桌面与窄屏截图。
- `verify-codex-169.ts`：默认 Code Mode 实际执行约 500 KB 输出并有界裁剪；中断旧文件审批后，迟到 cancel 不终止新轮、文件未写入。
- `verify-codex-1691-providers.ts`：原生 Mantle/Runtime/GCP 模型目录、独立 ultrafast、Bedrock/GCP 增量工具默认与显式关闭、reasoning/commentary/tool/最终答案重放。仅虚构令牌、已有 Node 认证命令与 loopback，不调用 AWS、Google 或 OpenAI 服务。
- `verify-managed-mcp.ts`：10 项真实工具发现、审批拒绝、父子会话、继续与重启、title/recap 无工具、配置不变和停服边界。

## 已授权的真实账号与网页冒烟

2026-11-20 用户明确授权使用现有认证发起少量 OpenAI 推理。只将认证复制到私有临时 CODEX_HOME，显式选用 0.171.0 / gpt-6.2-sol，项目、网关数据与历史均为临时目录：

- `live-smoke.ts --inference`：真实创建并校验 smoke.txt 内容、文件差异、无订阅期间 PID 保持、重订阅恢复、续聊完成和原生列表历史均通过。
- `live-upgrade-interactions.ts --inference`：真实嵌套 shell 活跃期间追加、中断回执、结束后拒绝迟到追加、下一轮完成、人工审批明确拒绝和旧审批响应过期共 5 项通过。
- `verify-codex-browser.ts --inference`：真实生产前端 → 网关 → CLI → OpenAI 返回精确标记；1280px 与 390px 页面截图和无横向溢出检查通过。

首个文件冒烟已完成真实编辑，但续聊验证曾把刚启动轮的历史快照误当中断终态。脚本现在以原生 `turn/completed` 回执为准，仅在故意断开订阅的首轮允许恢复已完成历史；没有放宽失败判断。修正后重新执行真实冒烟通过，不改动产品状态投影或自动重放任务。

原 auth.json / config.toml 的内容摘要与开始时一致，未输出凭证。三组冒烟结束后已删除临时认证目录；公开机器结果仅记录检查名称和隔离布尔结果，不包含认证、私有账号字段或临时 home 路径。前轮自动审批拒绝属于历史阻塞，已由这次明确授权解决。

## PR 截图与剩余审查边界

用户确认 Edge 的文件 URL 访问已开启后，使用 Browser Use 实际上传并发布以下评论，逐一确认图片在 GitHub 正常加载：

- [#355 provider 桌面/窄屏截图](https://github.com/yuzheng14/covro/pull/355#issuecomment-7033178096)：2 张。
- [#357 终止错误桌面/窄屏截图](https://github.com/yuzheng14/covro/pull/357#issuecomment-7033228937)：2 张。
- [#359 版本、历史及真实网页推理截图](https://github.com/yuzheng14/covro/pull/359#issuecomment-7033275597)：5 张。前 3 张使用本地模型 stub，后 2 张来自已授权的真实 OpenAI 请求，评论明确区分证据。

#356 为临时工具配置变更，没有用户界面增量。以上 UI 未在后续记录修正中变化，截图对应最终展示。没有修改扩展权限或绕过被禁止的浏览器地址。

仍待最终提交 CI 与人工审查，保持 Draft。`309b4be` 的 quality、八个浏览器分片、verify 和跨平台检查已全绿；冒烟脚本及本记录修正后的最新结果以 #359 为准。真实企业 IdP 无 refresh token、Cloud、远程 app-server/设备配对、MCP 跨环境登录、受管策略、Windows/手机真机、WebRTC、超大传输与完整 V1/V2 组合未逐项实测；不把少量真实 OpenAI 冒烟扩展为这些场景的全面验证。

## 回退

本轮不替换用户默认 CLI 或全局配置。显式选择完整 0.171.0 并重启网关；回退至 0.170.0 / 0.169.x / 0.167.0 等会重新要求 unverified 确认，不复用旧 epoch，也不自动重放任务。数据库版本仍为 11。

# Codex 0.172.0 升级验证

适配 [#374](https://github.com/yuzheng14/covro/issues/374)，日期为 2026-11-24（Asia/Shanghai）。在 Covro main `78cb9e9` 的 0.171.0 适配基础上，使用本机已有的完整 macOS arm64 0.172.0 安装。推荐和单一 verified 版本为 0.172.0，数据库版本为 11。 [官方 Release](https://github.com/openai/codex/releases/tag/rust-v0.172.0)

## 协议

上游 tag 从 `ccf9be8cc458bd6b8336fe84d68d8893f2691a5e` 到 `3d86e43b075adeba2193ec5c22ac92f55afd82e6`。项目生成器和独立空目录的稳定 TypeScript 文件逐字节一致。两版 binary 的结果和未截断 Git tree 吻合。 [上游 tag 比较](https://github.com/openai/codex/compare/rust-v0.171.0...rust-v0.172.0)

| 生成模式 | 文件数    | 新增 | 修改 | 删除 |
| -------- | --------- | ---- | ---- | ---- |
| 稳定     | 798 → 800 | 2    | 7    | 0    |
| 实验     | 968 → 970 | 2    | 11   | 0    |

- 三类 API 支出上限使用各自的 `CodexErrorInfo`，实时及恢复后继续沿用结构化错误投影。容量重试规则只接受容量错误码和既有文案兜底。 [上游限额](https://github.com/openai/codex/pull/62329) · [SSE 终态](https://github.com/openai/codex/pull/62356)
- `AppToolsConfig.approvals_reviewer` 为必需可空字段。实际工具审核仍由 Codex 依据工具配置和组织要求决定，Covro 按现有 RPC 请求 ID 提交人工决定。 [上游工具审核](https://github.com/openai/codex/pull/62360)
- 旧会话的 provider 模型目录、Fast、审核方等沿用已验证的精确版本门禁。Bedrock setup/login 可选择 Runtime，省略 `providerId` 时沿用 Mantle。新版模型目录包含 Daybreak 可用性。Covro 继续通过现有模型设置和账号读取接口工作。 [Bedrock](https://github.com/openai/codex/pull/62222) · [模型目录](https://github.com/openai/codex/pull/62499)
- 跨平台目录、workspace roots 和 writable roots 的稳定 TS 形状仍使用字符串。实验类型添加 Daybreak 传播字段、Bedrock setup 选项及 sample 模型覆盖。实时语音的 `sessionInputSaved` 带 `chunk` 或 `sessionEnd`。Covro 继续使用本地网关的目录归属和权限检查。 [工作目录](https://github.com/openai/codex/pull/62375) · [权限根目录](https://github.com/openai/codex/pull/62376) · [工作区根目录](https://github.com/openai/codex/pull/62377)

## 原生和浏览器验证

原生探针显式选择 0.172.0，在临时 `CODEX_HOME`、临时项目和 loopback stub 中运行。两个历史模式均完成流错误、失败恢复和 Code Mode 检查。

- `verify-codex-166.ts` 验证原生额度错误与无状态 policy 错误在 SSE 保持打开时立即结束，实时和重启后的冷历史代码一致，下一轮可成功。覆盖缺失 provider 恢复和 GCP 未登录读取。实际生产页面的桌面及 390px 历史均显示一次失败和后续完成，未进入容量重试。
- `verify-codex-172-mcp.ts` 验证 `config/read` 回传人工、自动及继承审核配置。原生 stdio 缓存预热后，普通轮次完成时进程仍未启动。首次调用成功回显，required 与关闭延迟开关的对照会提前启动。 [上游延迟启动](https://github.com/openai/codex/pull/62366)
- `verify-managed-mcp.ts` 覆盖现有 HTTP MCP 的发现、工具审批、子会话、重启和标题/recap 工具隔离。`verify-codex-169.ts` 覆盖 Code Mode 默认 gRPC 路径有界输出及迟到审批取消。 [上游 Code Mode](https://github.com/openai/codex/pull/62476)
- `verify-codex-upgrade.ts`、`verify-live-settings.ts`、`verify-provider-history.ts` 和 `verify-codex-1691-providers.ts` 覆盖恢复、原生压缩、Fork、命名权限、provider 目录、Fast 请求、审核方、Mantle/Runtime/GCP 与工具增量。实际浏览器检查了已验证版本、跨 provider 的历史及模型设置。
- 单元和集成测试 1,717 项通过、1 项跳过（`pnpm test --maxWorkers 4`），相关 Chromium 回归 76 项通过。类型、lint、格式、兼容声明、数据库契约、构建及生产产物检查通过。410 文件 npm 打包和隔离升级/回退 worker 使用本地 fixture。

真实 OpenAI 账号推理、Bedrock 认证写入、真实连接器的组织审批优先级、跨 OS 远端会话及云端语音未纳入本轮本地探针。

## Slash Command

0.171.0 和 0.172.0 的固定定义、解析/过滤及命令名弹窗的 blob 一致。固定 66 项，Web 16 个入口，状态为 **✅ 7 / 🟡 7 / ⬜ 20 / 🚫 32**。 [固定定义](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/tui/src/slash_command.rs) · [#69](https://github.com/yuzheng14/covro/issues/69)

上游增量为八个命令的首参数 Tab 补全、`/diff` 和 `/pwd` 的会话 cwd、`/status` 的远端版本显示以及 `/experimental` 对 `/statusline` 的开关。Web 本轮回归已有诊断、工作区 Git diff、目标参数和草稿交互。TUI 会话链接进入 Markdown 时保留显示文字，Web 保持现有 URL 规则。 [上游补全](https://github.com/openai/codex/pull/62343) · [会话链接](https://github.com/openai/codex/pull/62332)

# 权限模式

对应 [#72](https://github.com/yuzheng14/codex-web-ui/issues/72)，以下原始权限预设核验版本为 Codex 0.162.1。当前支持的 0.164.0 执行中更新边界见[配置生效时机](session-live-settings.md)：沙箱/profile 和审批策略下轮生效；在相同 workspace + on-request 边界下，仅审核方可更新后续步骤，已有审批保持原归属。

## 原生请求与确认

| 模式     | permissions           | approvalPolicy | approvalsReviewer |
| -------- | --------------------- | -------------- | ----------------- |
| 请求批准 | `:workspace`          | `on-request`   | `user`            |
| 帮我批准 | `:workspace`          | `on-request`   | `auto_review`     |
| 完全访问 | `:danger-full-access` | `never`        | `user`            |
| 只读     | `:read-only`          | `on-request`   | `user`            |

HTTP 设置接受一个 `permissionMode`，服务和 adapter 原样传递用户的显式选择；adapter 将它整体映射为上述三个 RPC 字段。旧的独立 sandbox / approvalPolicy / approvalReviewer API 保留兼容，但不能与 permissionMode 混传。只修改模型或强度时不附加任何权限覆盖。

`permissions`、响应中的 `activePermissionProfile`、受管要求中的 `allowedApprovalsReviewers` 是 0.162.1 实验协议字段，普通 generate-ts 不包含它们。扩展类型集中在 `src/codex/permissions.ts`，沿用已开启的 `initialize.capabilities.experimentalApi`，不修改生成文件。新建、恢复、Fork 和 turn/start 使用同一组映射；恢复已加载会话可能保留旧值，响应不等于选择已生效。只有完整回读或 `thread/settings/updated` 确认的模式才可清除草稿。

模式识别同时检查审核方、profile 身份/继承、网络、可写目录及临时目录排除设置。自定义 profile 或不同边界显示自定义；缺失 profile 来源或有效权限时保持未知。config/read 仅是磁盘分层配置，不能把其中的局部字段冒充会话的有效权限。网关只暴露白名单摘要，不暴露凭证、指令和整个权限配置。

选择之前读取 `configRequirements/read` 和 `experimentalFeature/list`，校验允许的 profile、沙箱、审批策略、审核方、模型自动审核要求以及 guardian_approval。已有会话使用 threadId 获取功能状态。未核验版本、接口缺失或读取失败时保留原配置并解释禁用原因。Codex 仍负责最终约束；上游拒绝不产生成功确认。

## 验证依据

- [0.162.1 内置预设](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/utils/approval-presets/src/lib.rs)、[权限菜单与审核方绑定](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/permissions_menu.rs)。
- [官方权限说明](https://learn.chatgpt.com/docs/sandboxing)、[自动审核说明](https://learn.chatgpt.com/docs/sandboxing/auto-review)：自动审核保留权限边界，不能用 never 或扩大沙箱模拟。
- 真实 app-server 0.162.1：在新临时工作目录创建空会话，四组参数回读符合上表；workspace 返回 networkAccess=false、writableRoots=[]、两个 exclude=false；两个受限模式分别返回正确 reviewer。没有修改全局 config.toml。
- 真实模型路由验证（2026-10-17）：同一临时目录、同一 workspace 边界下，执行两轮仅调用 `pwd` 的短任务。`user` 产生一次 `item/commandExecution/requestApproval`（测试回复拒绝）；`auto_review` 不产生人工请求，产生 `item/autoApprovalReview/started` / `completed`，结果 approved。自动审核时的设置通知回读 `:workspace / on-request / auto_review`、网络 false、空附加写入目录和两个 exclude=false。两轮均完成，没有文件变更。这里只验证了一次低风险自动获批，不代表自动拒绝、超时或所有工具类型的真实覆盖。
- fixture 集成测试验证参数校验、四模式切换、通知确认、恢复/Fork、继承自定义 profile、不相关设置不覆盖权限、禁用功能/受管约束和上游拒绝。fixture 是确定性协议验证，不代表真实模型行为。

本次不实现 `/permissions`，该入口继续由 #69 单独跟踪。

# Codex 0.171.0 协议审查

日期：2026-11-20（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。最终目标直接提升到 **0.171.0**，累计包含 0.168.0 / 0.169.0 / 0.169.1 / 0.170.0；沿用原生 [Stack #360](https://github.com/yuzheng14/covro/pull/360)，不单独发布中间适配版。此前证据保留在 [0.170.0 记录](codex-0.170.0-protocol.md)。

## 来源与生成

[官方 Release](https://github.com/openai/codex/releases/tag/rust-v0.171.0) 发布于 2026-11-20 08:44（Asia/Shanghai），精确 tag commit 为 `ccf9be8cc458bd6b8336fe84d68d8893f2691a5e`。[0.170.0 → 0.171.0 compare](https://github.com/openai/codex/compare/rust-v0.170.0...rust-v0.171.0) 为 diverged（ahead 341 / behind 4），仅返回 300 个文件；未截断的完整 Git tree 分别为 11,347 / 11,553 项，文件 blob 新增 226、修改 1,819、删除 33，不能只使用 compare 文件清单。

复用本机已有官方完整 `0.171.0-aarch64-apple-darwin` 安装，显式指定目标 binary。项目生成器与独立空目录稳定生成 **798 个 TypeScript 文件逐字节一致**；相对 0.170.0 新增 9、修改 18、无删除。原始生成目录未手改或格式化。实验生成 968 文件，相对 0.170.0 新增 13、修改 22、删除 2；删除的是 CurrentTimeReadParams / Response，目标原生 clock 改为同步读取，Covro 未实现客户端 clock 请求。

## 消费边界

- `account/updated` 新增必需可空 `reason`，包括 `workspaceRoutingReady` 与 `unknown`。现有处理仍重新读取规范账号与额度，不根据通知猜测身份或把路由就绪当成登出；增加同一账号路由就绪后的刷新回归，旧服务无 reason 的 JSON 仍兼容。
- [bioPolicy](https://github.com/openai/codex/pull/62176) 由原来的 `other` 显式暴露。现有结构化错误投影保留该代码；增加容量文案也不得重试的回归，以及真实目标 CLI 两种历史模式下的一次失败、冷历史读取验证。
- MCP 状态、OAuth、资源与工具调用新增 registration `environmentId`，若请求省略则保持旧的按名称选择。elicitation 的字段必需可空，fixture 补齐。Covro 仍按原始 RPC request ID 回复，未新增环境选择或 MCP 登录管理入口；工具历史的原始详情保留环境字段。不能把注册 scope 当成执行环境。
- `modelProvider/default/set` 新增稳定方法；现有 Web 仅保存模型/effort 默认值，没有默认 provider 管理功能，不误调用新方法或更改用户的 provider。provider 目录、实时 Fast/审核方门禁改为 **0.171.0 精确版本**，其他版本继续 unverified。
- `thread/list.includedThreadIds`、搜索 partial/cancel、实时音频历史分页与通道覆盖为新增原生能力。现有列表保持 cwd/provider/archive 分页约束；本轮不新增搜索取消、语音、Cloud 或远程 app-server 产品入口。
- 权限 profile 跨 cwd 保留、迟到 turn completion 不取消新审批、steering 聚合 diff、线程草稿/队列保留、MCP 无 refresh token 登录修复由 CLI 实现。恢复/profile、实时设置、审批、中断、历史与差异相关现有探针及浏览器回归重新在目标版本核验；真实企业 IdP、Cloud 和远程连接不计为已实测。

## Slash Command

精确核对 [固定定义](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/slash_command.rs)、[dispatch](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/chatwidget/slash_dispatch.rs)、[解析与过滤](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/slash_commands.rs)；command_popup.rs 的 blob 未变。

- 新增固定 `/rc`，显式别名 `/remote`；无参打开本地后台服务远程控制菜单，行内参数路径提示通过菜单 Disable 关闭。允许任务运行中、侧聊及线程不可用状态调用。Web 未实现远程设备配对/控制命令，记为 ⬜；现有网关远程访问不能冒充该功能。
- `/mcp login <name> [--environment <id>]` 新增精确环境选择，保持旧的名称（含空格/引号）路径；Web `/mcp` 仍为 ⬜，未增加登录或 environment 参数入口。
- `/statusline` 在 `tui_extensions_statusline` 开启时可选择 MCP provider；本地可创建自定义状态栏，Cloud 仅选择。`/experimental` 增加相应开关。仍为 TUI 专属，Web `/statusline` 保持 🚫，不新增后台 MCP 轮询或 authoring。
- 其余固定命令没有增删、重命名、别名或定义可用条件变化。固定清单 **65 → 66**，Web 保持 **16 个入口**，状态为 **✅ 7 / 🟡 7 / ⬜ 20 / 🚫 32**；`/remote` 作为别名单列，不重复计入固定数。同步更新 [#69](https://github.com/yuzheng14/covro/issues/69)。

实现与实际验证边界见 [升级验证](codex-0.171.0-verification.md)，没有把新原生协议等同于新增 Web 功能。

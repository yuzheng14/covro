# Codex 0.166.0 协议审查

日期：2026-11-02（Asia/Shanghai）。对应 [#301](https://github.com/yuzheng14/covro/issues/301)，累计比较 `rust-v0.164.0 → rust-v0.166.0`，不单独发布 0.165.0 适配版。

## 来源与生成

使用用户明确批准隔离使用的 [官方 0.166.0 完整包](https://github.com/openai/codex/releases/tag/rust-v0.166.0) `codex-package-aarch64-apple-darwin.tar.gz`，SHA-256：`55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0`。实际报告 `codex-cli 0.166.0`；包内包含同版 Code Mode host 和 standalone executor，没有替换全局 CLI。

通过现有 `pnpm codex:generate -- --config <显式选择目标 binary 的配置>` 生成稳定类型，空目录重复生成逐文件一致，未手改产物。稳定目录共 **760 个文件**，相对 0.164.0 **新增 9、修改 16、无删除**。统计按精确 tag 文件树和本地生成产物核对；0.165.0/0.166.0 的 GitHub compare 具有不同共同祖先，不能将所有提交或发布说明中的重复回移算成实际增量。

## 稳定变化与现有消费

- Account 增加 GCP 类型和 ChatGPT `workspaceName`。非 ChatGPT 额度继续显示不可用；账号/工作区身份变化会清空旧额度，真实 GCP 账号读取与 fixture 切换分别验证。不会因此新增登录或 GCP 设置 UI。
- CodexErrorInfo 新增 `modelNotFound`、`policyCapacityUnavailable`。前者保持终止；后者保留独立错误码和说明，纳入既有容量有限续跑保护。原生 retry 时不叠加；有进展/审批、结果不明、停止或新任务时不自动续跑，不修改模型/provider/权限。
- ModelProviderError 增加不匹配、未配置和策略冲突三类 JSON-RPC data。网关只保留已知分类的公开 provider ID 字段，长度有界，不将任意 error.data 透传浏览器；未知或不完整 data 保留原错误回退。
- ReviewDelivery 移除 detached。Covro 原本已明确请求 inline 并核对返回 thread ID，继续回归四类目标，无需改变审查流程。
- ThreadItem 增加可选 `startedAtMs/completedAtMs`；wire 仍平铺。支持字段缺失/null 和旧历史；现有映射保持 item ID 与载荷类型，不用 item 时间推断 turn 终态，也不新增逐 item 时间 UI。
- ImageGenerationItem 增加可空 `generationId`，继续保留 fileId/result 两种结果与可选 inputImages。通用详情原样保留，未新增图片下载或完整预览。
- ThreadUsage 增加可选 nativeUsageUsdMicros，未知不等于零；当前未新增会话美元用量 UI。
- ConfigRequirements 增加 otel，NetworkRequirements 增加 reviewDomains；Hooks 增加环境归属和 thread 查询，ProcessExited 增加输出收集超时标记，AdditionalContext 增加 name。保留允许展示字段的白名单，不整包暴露配置或凭证。
- 新增 AccountSession 系列和五个 Otel 类型，仅生成类型不等于接入其管理功能。

InitializeParams、ClientRequest、ServerRequest、ServerNotification、ThreadStart/Resume/Fork 参数、ThreadSettings 与 TurnStart/Steer 的稳定文件不变。被引用类型及行为已有变化，仍执行行为验证。

## 使用中的实验字段

用现有 0.164.0 与目标 0.166.0 分别生成 `--experimental` 到独立临时目录。ThreadStartParams/Response、ThreadResumeParams/Response、TurnStartParams、ThreadSettings、TurnSettingsUpdateParams 逐字节一致。ConfigRequirements 仅增加 otel 类型引用/字段，审核方限制、权限 profile、runtime roots 的使用契约保持。

ThreadForkParams 新增可选 attachToSource；目标说明要求 paginated source 和本地存储。现有普通 Fork 不发送该字段。新增 memory read、GCP setup、accountSession list/switch 等实验接口不增加本次产品范围。

已合并的 live-settings 仍有精确版本保护，本次将其核验目标改为 0.166.0，不以范围版本或 generated 类型存在代替真实验证。`reasoning_effort_override` 默认开启不等于 `step_model_switching` 默认开启；Fast 仍检查后者与模型能力，模型/强度保留下轮生效行为。

## Slash Command

精确 tag 的 slash_command.rs 在 0.164.0、0.165.0、0.166.0 间一致：固定 65 项，没有固定命令新增/删除/重命名、定义参数或显式别名变化。slash_dispatch.rs 则改变了 `/delete` 确认文案的条件，按 command center 是否启用决定返回中心或退出。

另记录 `/review` 仅 inline、`/status` workspace 名称、离线 `/quit`/`/exit` 与 `/keymap` transcript 导航行为变化。`codex queue --resume`、`doctor --network-only` 属于 shell 子命令。无新增 Web slash 入口，16 个现有入口的实现范围不因版本升级扩大；支持状态继续维护于 [#69](https://github.com/yuzheng14/covro/issues/69)。

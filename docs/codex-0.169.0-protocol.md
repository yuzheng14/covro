# Codex 0.169.0 协议审查

日期：2026-11-16（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。直接比较最终目标 `rust-v0.167.0 → rust-v0.169.0`，包含 0.168.0 的累计变化，不单独发布中间适配版。

## 来源与生成

复用本机已有官方完整安装 `0.169.0-aarch64-apple-darwin`，实际报告 `codex-cli 0.169.0`。包清单为 layoutVersion 1、variant codex，包含同版 CLI、Code Mode host、exec-server、resources 和 PATH 资源；未替换全局 CLI，未下载新的工具或依赖。

显式选择目标 binary 执行 `pnpm codex:generate -- --config <目标配置>`。稳定类型在两个空目录生成，**784 个文件路径及内容逐字节一致**；相对已提交的 0.167.0 产物新增 **23**、修改 **19**、删除 **0**。生成目录保持原始输出，未手改或格式化。来源由 `src/codex/protocol-version.json` 记录。

上游 [0.168.0 Release](https://github.com/openai/codex/releases/tag/rust-v0.168.0)、[0.169.0 Release](https://github.com/openai/codex/releases/tag/rust-v0.169.0)、精确 tag 的 schema 和 Rust 源码用于静态交叉核对；存在分叉且文件列表截断的 compare 不能单独用来统计增量。

## 稳定协议与消费策略

| 变化                                                                                              | 本轮处理                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/list.modelProvider`                                                                        | 会话按保存的 provider 查询完整分页目录；新草稿按有效默认 provider 查询。模型、effort、Fast 校验不借用其他 provider 的能力。每次校验重新经过上游策略检查，不增加本地长期缓存 |
| `agentMessage.moderation`                                                                         | 按 item ID 保留 moderation/display 白名单，区分缺失、null、false；流式完成、投影及传输裁剪保留元数据。未知 action 仅记录，不执行 Chat 专属展示动作                          |
| `account/read.userId`                                                                             | 纳入规范化账号缓存身份，缺失与 null 等价；账号变化丢弃旧额度快照与迟到回包，不额外暴露 userId                                                                               |
| `inferenceHookDenied`                                                                             | 独立终止错误；与 `sessionBudgetExceeded` 等终止原因一起禁止容量文案兜底和自动续跑                                                                                           |
| provider 管理、OAuth、securitySetup                                                               | 更新生成类型，不将可选管理方法作为初始化前提，不新增凭证管理或安全提醒 UI                                                                                                   |
| `currentAccountOnly`                                                                              | 保持默认发现范围；继续明确传 `modelProviders: []`、精确 cwd/sourceKinds 和 opaque cursor，不将账号筛选误当访问控制                                                          |
| `deferOutput` / `ThreadItemOutputDeferral`                                                        | 两条历史分页路径均不启用 command/MCP output deferral，继续读取完整的已保存输出。稳定空对象不能当成已实现实验能力                                                            |
| `contentTokenCount`、`QueuedSubmission.responsesapiClientMetadata`、`McpResourceReadParams._meta` | 不推导会话总用量，不允许浏览器覆盖保留身份/路由元数据；生成类型不代表新浏览器入口                                                                                           |
| 音频、搜索 provider、PluginInterface                                                              | 保留现有产品范围，不因 schema 更新承诺音频上传/播放、搜索配置或插件管理能力                                                                                                 |

目标版 [App Server 契约](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/README.md) 和 [ModelListParams](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server-protocol/schema/typescript/v2/ModelListParams.ts) 是 provider selector 的依据。保存的 provider 恢复行为来自 [#59503](https://github.com/openai/codex/pull/59503)，模型目录来自 [#59776](https://github.com/openai/codex/pull/59776)。旧会话仍用旧 endpoint，新会话用新默认 endpoint；缺失 provider 仍拒绝，不用 resume 参数迁移 provider。外部 provider 的选择仅应用当前会话，不写入默认 provider 的配置。

## 实验契约与生命周期

目标版本的 `--experimental` 独立生成到临时目录。现有权限/profile、ThreadStart/Resume/Fork、ThreadSettings、TurnStart、TurnSettingsUpdate 与审核方路径结合精确 Rust 来源和原生探针核对。**本机已无 0.167.0 binary，未重复生成旧版实验类型**；旧版比较依据为已有 [0.167.0 记录](codex-0.167.0-protocol.md) 与精确 tag 源码，不声称完成两版实验产物逐字节比较。

- 新 `environments` 不扩大 Web 实时设置范围；请求省略该字段，不发送空数组清空环境。模型/effort 继续下轮生效，Fast/审核方只有目标精确版本、原生 feature、模型能力及 applied 回执均满足时才实时生效。
- 临时标题和 recap 显式使用 `agents.enabled=false` 与 `features.multi_agent_v2=false`，保留 shell、MCP、hooks、插件及权限隔离；移除弃用的 `features.multi_agent` 覆盖。
- 默认开启的 Code Mode host gRPC 与输出截断由同版完整安装处理；Covro 不直接调用私有 host 协议。原生探针验证约 500 KB 文本输出被有界截断，不把预览当成全文。
- 文件审批取消绑定原 turn。原生探针覆盖中断 A、启动 B、迟到取消 A，B 仍完成；网页旧卡片的失效与重放由现有 fixture 覆盖。
- 普通 Fork 不发送 attachToSource，不将实验 attached threads 当成普通分叉或子代理父子关系。历史 deferral、侧聊管理和批准计划清空上下文交接不在本轮新增范围。

## Slash Command

三个版本固定枚举仍为 **65 项**；现有 Web **16 个入口**不扩容。0.169.0 的 `/rename` 侧聊可用条件、`/side` / `/btw` 持久侧聊描述、`/delete` 侧聊联动、`/feedback` 编辑器及 ZIP、`/plan` 实验交接变化均同步到 [#69](https://github.com/yuzheng14/covro/issues/69)。已有 UI 或协议定义不等于实现对应 Slash Command。实施与验证边界见 [升级验证](codex-0.169.0-verification.md)。

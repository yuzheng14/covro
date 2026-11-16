# Codex 0.170.0 协议审查

日期：2026-11-18（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。最终目标直接提升到 **0.170.0**，累计包含 0.168.0、0.169.0、0.169.1；不单独发布中间适配版。此前实现与证据保留在 [0.169.0 协议记录](codex-0.169.0-protocol.md)。

## 来源与精确比较

复用本机已有官方完整 `0.170.0-aarch64-apple-darwin` 安装，实际报告 `codex-cli 0.170.0`。包清单为 layoutVersion 1、variant codex，含同版 CLI、Code Mode host、exec-server、resources 与 PATH 资源；未下载依赖、替换默认 CLI 或修改用户全局配置。

[0.170.0 Release](https://github.com/openai/codex/releases/tag/rust-v0.170.0) 发布于 2026-11-18 11:40（Asia/Shanghai）。[0.169.1 → 0.170.0 compare](https://github.com/openai/codex/compare/rust-v0.169.1...rust-v0.170.0) 为 diverged（ahead 52 / behind 5），文件列表截断到 300；两个精确 tag 的完整 Git tree 均未截断，文件 blob 比较为新增 31、修改 450、删除 2，不把 compare 当成完整差异清单。

显式指定目标 binary，两次在空目录生成稳定类型，**789 文件路径与内容逐字节一致**。原始生成目录未经手改或格式化，来源记录在 `src/codex/protocol-version.json`。

| 对比                                | 稳定类型  | 新增 | 修改 | 删除 |
| ----------------------------------- | --------- | ---- | ---- | ---- |
| 0.169.0 → 0.169.1                   | 784 → 784 | 0    | 0    | 0    |
| 0.169.1 → 0.170.0                   | 784 → 789 | 5    | 2    | 0    |
| 当前 main 的 0.167.0 → 最终 0.170.0 | 761 → 789 | 28   | 19   | 0    |

实验类型也由实际安装生成：0.169.0 / 0.169.1 的 951 文件逐字节一致；0.170.0 为 957 文件，新增 6、修改 4、无删除。本机已有旧实验产物可作实际比较，不用源码预期替代结果。

## 0.169.1 累计行为

[模型目录更新](https://github.com/openai/codex/pull/62106) 加入 GPT-6.2 Sol/Astra，更新 bundled、Bedrock Mantle/Runtime 与 GCP 目录、默认排序，扩展 Runtime 的 global/us 前缀，并增加 GPT-6.1 Sol 的目录上下文窗口。Covro 按上游返回的 provider 目录和原生上下文用量工作，不硬编码新模型或窗口大小；显式保存的旧模型选择继续保留。

[Bedrock 默认增量工具](https://github.com/openai/codex/pull/61426) 与 [Mantle commentary 规范化](https://github.com/openai/codex/pull/62095) 均在完整目标 CLI 内处理。Covro 不重写模型请求前缀或自行剥离 annotations。原生探针覆盖 Mantle/Runtime 的默认 `additional_tools`、显式关闭、continuation / 下一轮重放、reasoning/tool 顺序和最终答案 annotations。新 Astra 的 `ultrafast` 独立保留，不映射为 Fast，不新增 Web 服务等级入口。

## 0.170.0 答案展示契约

[AgentMessageDisplay](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server-protocol/schema/typescript/v2/AgentMessageDisplay.ts) 从旧 action 对象改为 `version: 1` 的 show / hide / block 联合类型。新增 AnswerAnnotation、AnswerReplacement、BlockReason、HelplineSubject、TrustedContacts 五个稳定类型。

- 共享投影保留支持的 v1 分支，校验枚举、必需字段和布尔值，区分 false、缺失与 null，并剥离无关字段。protectionType 保持有界。
- 未知版本、mode、嵌套 kind 或错误类型不能回退为旧 action；按照 [上游存储契约](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/protocol/src/items/display.rs)，保留 `moderated: true`、丢弃不可读展示指令，不能解除受限标记。
- 旧版无版本 action 元数据继续可读；新字段按答案 item ID 更新，传输裁剪、冷投影恢复和显式 null 清除不传播到其他答案。
- 这些是 Chat 专属展示元数据。Covro 不执行自动替换、隐藏、联系可信联系人或其他 Chat 动作，不把它们当成任务终态、权限决定或工具授权。

## 其他协议与行为边界

稳定方法、Thread/Turn 参数、MCP server-request 及现有权限结构未因这次稳定生成发生变化。实验 ThreadGuardianReviewParams 仅更新复用/订阅语义说明，Covro 不调用 direct review；UserVerificationVerifyResponse 新增可空 biometricType 与新枚举，未接入原生生物验证入口。

- [权限更新规范化](https://github.com/openai/codex/pull/61134)、legacy sandbox template 保留及 profile label 比较由 CLI 负责。Web 继续发送已校验的 profile/权限设置；Fast/审核方只在目标精确版本、原生 feature、模型能力和 applied 回执均满足时生效。原生恢复/Fork/profile 与实时设置探针重新执行。
- GCP 默认增量工具声明由 [#60848](https://github.com/openai/codex/pull/60848) 引入；目标探针使用已有 Node 输出虚构令牌、固定 loopback endpoint，验证默认开启与显式关闭，不依赖 Google 账号或安装 gcloud。
- 模型侧 ID、保留答案修订和压缩后的历史由 CLI 持久化；Covro 保持原生 item/turn ID，不解析或重写模型历史。既有冷恢复、Fork、压缩与稳定消息投影继续回归。
- 超大 WebSocket 请求回退 HTTP、Cloud 恢复、MCP OAuth 竞争、Windows 原子替换、Code Mode 503、OTLP 刷新认证均为 CLI 行为；不因此增加 Covro 私有传输、OAuth 或遥测配置接口。真实 Cloud/Windows/受管策略仍单列验证边界。
- 同名跨环境 MCP 是实验能力；Covro 的回答仍绑定原始 RPC ID，未新增环境选择 UI。实时 WebRTC voice、原生生物验证和完整 Cloud backend 不在本轮新增产品范围。

## Slash Command

精确 Git tree 中没有 Slash Command 相关文件变化；slash_command.rs、bottom_pane/slash_commands.rs、command_popup.rs 也与 0.169.1 逐字节一致。固定清单仍为 **65 项**，Web 仍为 **16 个入口，✅ 7 / 🟡 7 / ⬜ 19 / 🚫 32**。新模型的原生 ultrafast 可用条件不等于新增 Web slash 支持。版本依据及待合并 PR 同步到 [#69](https://github.com/yuzheng14/covro/issues/69)。

实际验证、图片上传与账号授权状态见 [验证记录](codex-0.170.0-verification.md)。

# Codex 0.167.0 协议审查

日期：2026-11-09（Asia/Shanghai），对应 [#327](https://github.com/yuzheng14/covro/issues/327)。比较 `rust-v0.166.0 → rust-v0.167.0`，保留精确版本边界。

## 来源与生成

复用本机已有官方完整安装 `~/.codex/packages/app-server-daemon/releases/0.167.0-aarch64-apple-darwin`。包清单为 layoutVersion 1、variant codex、target aarch64-apple-darwin，包含 CLI、Code Mode host、exec-server 与 resources；实际 CLI 报告 `codex-cli 0.167.0`。未下载、安装依赖或替换全局 CLI。

使用现有 `scripts/generate-codex.ts --config <显式选择目标 binary 的配置>`，在临时 CODEX_HOME 生成稳定类型。独立空目录重复生成，**761 个文件逐字节一致**；相对已提交 0.166.0 产物新增 1、修改 8、无删除，未手改产物。上游 [Release](https://github.com/openai/codex/releases/tag/rust-v0.167.0) 和两个精确 tag 的完整文件树提供静态交叉核对；GitHub compare 具有不同共同祖先且文件列表截断，不用它单独统计增量。

## 稳定协议

- InitializeCapabilities 新增 `requiredHumanApproval`，需同时启用 experimentalApi；CommandExecutionApprovalKind 新增 `humanCommand`。受管 `prompt-user` 检查点仅接受 accept/decline/cancel，不能以会话、规则或自动审核批准替代；无符合能力的连接时命令拒绝。提示本身不创建执行 item。完整契约见 [目标版 README](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server/README.md)。
- 新增 `thread/section/changed` 和 ThreadSectionChangedNotification，更新 ServerNotification、Envelope 与 v2/index；sectionId 可为 null，组内重排也会通知。Covro 未消费原生 section 管理，不映射为项目或工作区。
- UserInput.audio 扩为 url/fileId，ContentItem.input_audio 扩为 audio_url/file_id。现有历史映射保留音频类型占位，不承诺上传或播放能力。
- OtelRequirements 增加可空 log_sse_deltas。不改变配置展示白名单，不向浏览器整包透传受管遥测配置。

稳定 ClientRequest、ServerRequest、ThreadList/Start/Resume/Fork 和 TurnStart/Steer 参数文件本身不变；引用类型与行为的变化仍需验证。

## 实验字段

分别用已有 0.166.0 与目标 0.167.0 安装生成 `--experimental` 到独立临时目录。ThreadStartParams/Response、ThreadResumeParams/Response、ThreadForkParams、ThreadSettings、TurnStartParams、TurnSettingsUpdateParams 逐字节一致。现有权限/profile、审核方与 live-settings 的扩展契约未由这些文件改变；精确门禁须以真实运行验证为准。

除稳定变化外，新增实验 thread/guardianReview 与 Guardian assessment 类型；ThreadSampleParams 增加可空 interruptOnCancel。不扩展为 Web 审查、注入工具或 sample 管理入口；thread/guardianReview 不等于 /review 或 /approve。

## Slash Command

0.166.0 与 0.167.0 的 slash_command.rs、bottom_pane/slash_commands.rs、command_popup.rs blob 一致，固定清单仍为 65 项，无枚举、定义参数、别名或这些文件中的过滤变化。slash_dispatch.rs 将 /delete 确认文案统一为返回 command center，并对参数准备中的本地图片集合使用 to_vec()。

另外记录 /resume 的跨 provider/backend 行为、/experimental 的可选系统代理，以及 Ctrl+L 清屏后 Ctrl+T 仍保留历史的修复；后者与 /clear 新建会话的语义分开。codex agents --no-daemon 是 shell 子命令。现有 16 个 Web 入口不因升级扩大范围，支持状态继续维护于 [#69](https://github.com/yuzheng14/covro/issues/69)。
